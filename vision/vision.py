"""
SENTINEL-X - Module Vision (filière IA) - v4 : modèle de données v0.4
- Lit la webcam USB
- Détecte et SUIT les personnes et les animaux (YOLOv8n-seg + ByteTrack)
- Reconnaît les visages (YuNet + SFace) grâce aux tables persons + face_embeddings
- Repère les objets SEULEMENT s'ils bougent
- Enregistre chaque apparition dans face_sightings
- 3 cas :
    * authorized   -> vert, son nom, pas d'alerte
    * unknown      -> rouge, PERSONNE INCONNUE, alerte (l'inconnu est mémorisé 72 h)
    * unidentified -> orange, NON IDENTIFIE, alerte (pas de visage analysable)
- Diffuse la vidéo annotée : http://<IP_DU_SERVEUR>:5001/video

Utilisation :
    python vision.py                                   (webcam)
    python vision.py --video test.mp4                  (fichier vidéo)
    python vision.py --video test.mp4 --save out.mp4   (+ enregistre le résultat)
"""

import argparse
import os
import queue
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import requests
from dotenv import load_dotenv
from flask import Flask, Response
from ultralytics import YOLO

from faces import (MODEL_VERSION, UNKNOWN_MAX_SCORE, FaceEngine, embedding_from_image,
                   ensure_models, face_quality, from_db, to_db)

load_dotenv()

# ==================== CONFIGURATION (à adapter) ====================
CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))  # Numéro de la webcam (réglé dans .env)
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
YOLO_MODEL = "yolov8n-seg.pt"   # "-seg" = donne aussi la silhouette exacte des personnes
IMG_SIZE = 640              # 320 sur Raspberry Pi
PERSON_CONF_MIN = 0.5       # Confiance minimale pour accepter une PERSONNE
ANIMAL_CONF_MIN = 0.6       # Confiance minimale pour accepter un ANIMAL (évite les faux animaux)
TRACK_CONF = 0.3            # Confiance donnée au suivi (plus bas = suivi plus stable)
MIN_TRACK_FRAMES = 8        # Une détection doit durer 8 images avant de pouvoir alerter
UNIDENTIFIED_DELAY = 3      # Secondes sans visage avant de dire NON IDENTIFIE
OBJECT_ALERT_COOLDOWN = 30  # Secondes minimum entre deux alertes "objet qui bouge"
UNKNOWN_CONFIRM = 5         # Nb d'analyses "clairement inconnu" avant de déclarer INCONNU
AMBIGUOUS_WEIGHT = 0.25     # Une analyse "ressemble un peu à quelqu'un" compte pour 1/4
SHOW_SCORES = False         # True = affiche le score sous chaque cadre (pour régler les seuils)
RECOGNIZE_CONFIRM = 2       # Nb d'analyses concordantes avant de donner un nom
VERIFY_INTERVAL = 2         # Re-vérifie le visage toutes les 2 s (évite les échanges de nom)
CAMERA_RETRY_FRAMES = 30    # Images ratées avant de reconnecter la webcam
TRACK_TIMEOUT = 10          # Secondes avant d'oublier une personne sortie du champ
TRACKER_CONFIG = "sentinel_tracker.yaml" if Path("sentinel_tracker.yaml").exists() else "bytetrack.yaml"

ANIMAL_CLASSES = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]  # oiseau, chat, chien...
MOTION_MIN_AREA = 800       # Taille minimale (pixels) d'un objet qui bouge (plus petit = voit plus loin)
MOTION_WARMUP = 50          # Images pour apprendre le décor au démarrage
MOTION_PERSIST = 10         # L'objet doit bouger pendant 10 images de suite
MOTION_MAX_RATIO = 0.4      # Si plus de 40 % de l'image change : c'est la lumière, on ignore
BOX_MARGIN = 60             # Marge autour des animaux (et des personnes si pas de silhouette)
SILHOUETTE_MARGIN = 15      # Marge autour de la silhouette d'une personne (pixels)

STREAM_PORT = 5001
SHOW_WINDOW = True

# "database" (tables persons + face_embeddings) ou "folder" (test sans base)
KNOWN_FACES_SOURCE = "database"
KNOWN_FACES_FOLDER = "personnes_autorisees"
RELOAD_INTERVAL = 60        # Recharge les visages toutes les 60 s
# ===================================================================

API_URL = os.getenv("API_URL", "http://192.168.10.1:3000/api/v1/alerts")
API_BASE = API_URL.rsplit("/alerts", 1)[0]          # ex : http://.../api/v1
API_HEADERS = {"X-Api-Key": os.getenv("API_KEY", "")}  # clé du service vision
DEVICE_ID = os.getenv("DEVICE_ID", "SX-001")
USE_DB = KNOWN_FACES_SOURCE == "database"

PERSON_CLASS_ID = 0
GREEN, RED, ORANGE, YELLOW = (0, 200, 0), (0, 0, 255), (0, 165, 255), (0, 255, 255)
STYLE = {
    "authorized": (GREEN, None),          # None = afficher le nom
    "unknown": (RED, "PERSONNE INCONNUE"),
    "unidentified": (ORANGE, "NON IDENTIFIE"),
    "analysing": (YELLOW, "ANALYSE..."),
}
PERSON_STATUSES = ("authorized", "unknown")

latest_jpeg = None
frame_lock = threading.Lock()
known_faces = []            # Liste de {"person_id", "name", "status", "emb"}
known_lock = threading.Lock()
app = Flask(__name__)


def parse_tls(value):
    v = value.strip().lower()
    if v in ("true", "1", "yes"):
        return True
    if v in ("false", "0", "no"):
        return False
    return value.strip()


TLS_VERIFY = parse_tls(os.getenv("TLS_VERIFY", "true"))


# -------------------- Base de données --------------------
def db_connect():
    import psycopg
    return psycopg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME", "sentinel"),
        user=os.getenv("DB_USER", "vision_service"),
        password=os.getenv("DB_PASSWORD"),
        connect_timeout=5,
        autocommit=True,
    )


def api_call(method, path, payload=None):
    """Appel à l'API Sentinel-X avec la clé du service vision."""
    r = requests.request(method, f"{API_BASE}{path}", json=payload, timeout=5,
                         verify=TLS_VERIFY, headers=API_HEADERS)
    if r.status_code >= 400:
        raise RuntimeError(f"API {r.status_code} : {r.text[:200]}")
    return r.json() if r.content else None


class DbWriter:
    """Enregistre les personnes vues via l'API, dans un thread à part,
    pour ne jamais bloquer la vidéo. vision.py n'écrit plus en base directement."""

    def __init__(self):
        self.jobs = queue.Queue()
        self.sightings = {}     # clé de suivi -> id de la ligne face_sightings
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, job, *args):
        self.jobs.put((job, args))

    def _run(self):
        while True:
            job, args = self.jobs.get()
            try:
                getattr(self, "_" + job)(*args)
            except Exception as e:
                print(f"[API] Erreur ({job}) : {e}")

    def _new_unknown(self, person_id, name, emb):
        api_call("POST", "/persons/unknowns", {
            "id": str(person_id), "display_name": name,
            "embedding": to_db(emb), "model_version": MODEL_VERSION})

    def _visit(self, person_id, status):
        api_call("POST", f"/persons/{person_id}/visits")

    def _sighting(self, key, person_id, similarity, status, track_id):
        if person_id is None:
            return          # le schéma exige une personne : pas de passage « non identifié »
        payload = {"person_id": str(person_id), "similarity": float(similarity or 0.0),
                   "status_at_time": status}
        if key in self.sightings:
            api_call("PATCH", f"/persons/sightings/{self.sightings[key]}", payload)
        else:
            row = api_call("POST", "/persons/sightings",
                           {**payload, "device_id": DEVICE_ID, "track_id": track_id})
            self.sightings[key] = row["id"]

    def _alert_link(self, keys, alert_id):
        for k in keys:
            if k in self.sightings:
                api_call("PATCH", f"/persons/sightings/{self.sightings[k]}",
                         {"alert_id": alert_id})


db = DbWriter() if USE_DB else None


# -------------------- Visages connus --------------------
def load_from_database():
    query = (
        "SELECT p.id, COALESCE(p.display_name, 'Inconnu'), p.status, e.embedding "
        "FROM persons p JOIN face_embeddings e ON e.person_id = p.id "
        "WHERE e.model_version = %s "
        "AND (p.status <> 'authorized' OR p.consent_at IS NOT NULL) "
        "AND (p.expires_at IS NULL OR p.expires_at > NOW())")
    with db_connect() as conn:
        rows = conn.execute(query, (MODEL_VERSION,)).fetchall()
    return [{"person_id": pid, "name": name, "status": status, "emb": from_db(emb)}
            for pid, name, status, emb in rows]


def load_from_folder(engine):
    """Test sans base : une photo 'Prenom.jpg' ou un sous-dossier par personne."""
    folder = Path(KNOWN_FACES_FOLDER)
    folder.mkdir(exist_ok=True)
    known = []
    for path in sorted(folder.rglob("*")):
        if path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        image = cv2.imread(str(path))
        emb = embedding_from_image(engine, image) if image is not None else None
        if emb is None:
            print(f"[ATTENTION] Aucun visage trouvé sur : {path.name}")
            continue
        name = path.parent.name if path.parent != folder else path.stem
        known.append({"person_id": None, "name": name, "status": "authorized", "emb": emb})
    return known


_last_count = None


def reload_known_faces():
    global known_faces, _last_count
    try:
        known = load_from_database() if USE_DB else load_from_folder(FaceEngine())
        with known_lock:
            known_faces = known
        people = len({k["person_id"] or k["name"] for k in known})
        if (people, len(known)) != _last_count:      # affiché seulement si ça change
            _last_count = (people, len(known))
            print(f"[INFO] {people} personne(s) connue(s), {len(known)} empreinte(s)")
    except Exception as e:
        print(f"[ERREUR] Chargement des visages : {e}")


def reload_loop():
    while True:
        time.sleep(RELOAD_INTERVAL)
        reload_known_faces()


# -------------------- Alertes --------------------
ALERT_RULES = {   # type -> (severity, message)
    "unknown_person": ("critical", "Personne inconnue détectée"),
    "unidentified": ("warning", "Présence non identifiée"),
}


def send_alert(alert_type, labels, keys, causes=None):
    severity, message = ALERT_RULES[alert_type]
    payload = {                       # Format de la table "alerts" (modèle v0.4)
        "device_id": DEVICE_ID,
        "source": "vision",
        "type": alert_type,
        "severity": severity,
        "message": f"{message} ({len(labels)})"[:140],
        "details": {
            "count": len(labels),
            "labels": labels,
            "causes": causes or [],
            "detected_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    try:
        r = requests.post(API_URL, json=payload, timeout=2, verify=TLS_VERIFY,
                          headers=API_HEADERS)
        if r.status_code >= 400:
            print(f"[ALERTE] Refusée par l'API ({r.status_code}) : {r.text[:200]}")
            return
        print(f"[ALERTE] Envoyée ({r.status_code}) : {alert_type} -> {', '.join(causes or labels)}")
        try:
            alert_id = r.json().get("id")
        except ValueError:
            alert_id = None
        if alert_id and db and keys:
            db.submit("alert_link", keys, alert_id)
    except requests.RequestException as e:
        print(f"[ALERTE] Échec de l'envoi : {e}")


# -------------------- Flux vidéo --------------------
def generate_stream():
    while True:
        with frame_lock:
            frame = latest_jpeg
        if frame is None:
            time.sleep(0.05)
            continue
        yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n")
        time.sleep(0.05)


@app.route("/video")
def video():
    return Response(generate_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")


def run_server():
    app.run(host="0.0.0.0", port=STREAM_PORT, threaded=True, use_reloader=False)


# -------------------- Personnes --------------------
def new_track():
    return {"key": uuid.uuid4().hex, "status": None, "person_id": None, "name": None,
            "similarity": None, "unknown_hits": 0.0, "votes": {}, "verified_at": 0.0,
            "mismatches": 0, "recorded": None, "last_seen": 0.0, "debug": "",
            "no_face_since": None, "frames": 0}


def reset_identity(track):
    """Oublie l'identité (le suivi s'est trompé de personne)."""
    track.update(status=None, person_id=None, name=None, unknown_hits=0.0,
                 votes={}, mismatches=0)


def person_key(entry):
    return entry["person_id"] or entry["name"]


def face_in_box(box, faces):
    x1, y1, x2, y2 = box
    inside = [f for f in faces
              if x1 <= f[0] + f[2] / 2 <= x2 and y1 <= f[1] + f[3] / 2 <= y2]
    return max(inside, key=lambda f: f[2] * f[3]) if inside else None


def classify_person(track, box, faces, engine, frame, now):
    """Retourne le statut de la personne suivie."""
    face = face_in_box(box, faces)
    usable = face is not None and face_quality(face)

    # Déjà identifiée : on garde son nom grâce au suivi,
    # mais on re-vérifie régulièrement quand le visage est bien visible
    if track["status"] in PERSON_STATUSES:
        if usable and now - track["verified_at"] > VERIFY_INTERVAL:
            track["verified_at"] = now
            with known_lock:
                known = list(known_faces)
            match, infos = engine.identify(engine.embedding(frame, face), known)
            track["debug"] = f"{infos['best_name']} {infos['best_score']:.2f}"
            same = match is not None and person_key(match) == (track["person_id"] or track["name"])
            track["mismatches"] = 0 if same else track["mismatches"] + 1
            if track["mismatches"] >= 2:
                reset_identity(track)
                return "analysing"
        return track["status"]

    # Pas de visage, ou visage de profil / trop petit : impossible d'identifier.
    # On laisse quelques secondes à la personne pour montrer son visage.
    if not usable:
        if track["no_face_since"] is None:
            track["no_face_since"] = now
        if now - track["no_face_since"] < UNIDENTIFIED_DELAY:
            return "analysing"
        return "unidentified"
    track["no_face_since"] = None

    emb = engine.embedding(frame, face)
    with known_lock:
        known = list(known_faces)
    match, infos = engine.identify(emb, known)
    track["similarity"] = infos["best_score"]
    track["verified_at"] = now
    track["debug"] = f"{infos['best_name']} {infos['best_score']:.2f}"

    if match:
        # Il faut plusieurs analyses concordantes avant de donner un nom
        key = person_key(match)
        track["votes"][key] = track["votes"].get(key, 0) + 1
        if track["votes"][key] < RECOGNIZE_CONFIRM:
            return "analysing"
        track.update(status=match["status"], person_id=match["person_id"], name=match["name"])
        if db and match["person_id"]:
            db.submit("visit", match["person_id"], match["status"])
        return track["status"]

    # Pas reconnu. Si le visage ressemble un peu à une personne autorisée,
    # c'est peut-être elle sous un mauvais angle : on compte moins fort.
    if infos["auth_score"] >= UNKNOWN_MAX_SCORE:
        track["unknown_hits"] += AMBIGUOUS_WEIGHT
    else:
        track["unknown_hits"] += 1
    if track["unknown_hits"] < UNKNOWN_CONFIRM:
        return "analysing"

    # Inconnu confirmé : on le mémorise pour le reconnaître s'il revient
    person_id = uuid.uuid4() if db else None
    name = f"Inconnu-{str(person_id)[:4]}" if person_id else "Inconnu"
    track.update(status="unknown", person_id=person_id, name=name)
    if db:
        db.submit("new_unknown", person_id, name, emb)
        with known_lock:
            known_faces.append({"person_id": person_id, "name": name,
                                "status": "unknown", "emb": emb})
    return "unknown"


VIDEO_FILE = None           # Rempli par --video
SAVE_FILE = None            # Rempli par --save


def open_camera():
    if VIDEO_FILE:
        return cv2.VideoCapture(VIDEO_FILE)
    cap = cv2.VideoCapture(CAMERA_INDEX)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    return cap


# -------------------- Boucle principale --------------------
def vision_loop():
    global latest_jpeg

    print("[INFO] Chargement des modèles...")
    model = YOLO(YOLO_MODEL)
    face_engine = FaceEngine()
    watched = [PERSON_CLASS_ID] + ANIMAL_CLASSES
    background = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=40,
                                                    detectShadows=True)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    cap = open_camera()
    if not cap.isOpened():
        if VIDEO_FILE:
            print(f"[ERREUR] Impossible d'ouvrir la vidéo : {VIDEO_FILE}")
        else:
            print("[ERREUR] Webcam introuvable. Vérifie CAMERA_INDEX.")
        os._exit(1)

    writer = None
    if SAVE_FILE:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        writer = cv2.VideoWriter(SAVE_FILE, cv2.VideoWriter_fourcc(*"mp4v"),
                                 fps, (FRAME_WIDTH, FRAME_HEIGHT))
        print(f"[INFO] Enregistrement du résultat dans : {SAVE_FILE}")

    print(f"[INFO] Vision démarrée (boîtier {DEVICE_ID}). "
          f"Flux : http://localhost:{STREAM_PORT}/video")
    tracks = {}
    alerted = {}              # clé -> moment de l'alerte (une seule alerte par apparition)
    animal_frames = {}        # animal suivi -> nombre d'images où il a été vu
    last_object_alert = 0.0
    motion_frames = 0
    times = []
    avg_ms = 0.0
    frame_count = 0
    failures = 0

    while True:
        ok, frame = cap.read()
        if not ok and VIDEO_FILE:
            print("[INFO] Fin de la vidéo.")
            break
        if not ok:
            # Webcam débranchée ou bloquée : on la reconnecte automatiquement
            failures += 1
            if failures >= CAMERA_RETRY_FRAMES:
                print("[ATTENTION] Webcam perdue, reconnexion...")
                cap.release()
                time.sleep(1)
                cap = open_camera()
                failures = 0
                tracks = {}
                frame_count = 0
            time.sleep(0.1)
            continue
        failures = 0
        frame = cv2.resize(frame, (FRAME_WIDTH, FRAME_HEIGHT))
        t0 = time.perf_counter()
        now = time.time()
        frame_count += 1

        # 1. Détection + suivi des personnes et animaux
        results = model.track(frame, imgsz=IMG_SIZE, conf=TRACK_CONF, classes=watched,
                              persist=True, tracker=TRACKER_CONFIG, verbose=False)
        persons, animals = [], []
        # Silhouette exacte des personnes (corps + mains), pour séparer
        # la personne d'un objet qu'elle tient (ex : une feuille)
        person_mask = np.zeros(frame.shape[:2], dtype=np.uint8)
        masks = results[0].masks
        for i, b in enumerate(results[0].boxes):
            box = tuple(map(int, b.xyxy[0]))
            track_id = int(b.id[0]) if b.id is not None else None
            conf = float(b.conf[0])
            if int(b.cls[0]) == PERSON_CLASS_ID:
                # Même une détection peu sûre protège sa zone (son mouvement
                # ne doit pas être pris pour un objet), mais elle ne compte
                # comme personne qu'au-dessus de PERSON_CONF_MIN
                if conf >= PERSON_CONF_MIN:
                    persons.append((box, track_id))
                if masks is not None and len(masks.xy[i]) > 2:
                    cv2.fillPoly(person_mask, [masks.xy[i].astype(np.int32)], 255)
                else:   # pas de silhouette : on protège tout le cadre (avec marge)
                    x1, y1, x2, y2 = box
                    cv2.rectangle(person_mask, (x1 - BOX_MARGIN, y1 - BOX_MARGIN),
                                  (x2 + BOX_MARGIN, y2 + BOX_MARGIN), 255, -1)
            elif conf >= ANIMAL_CONF_MIN:
                animals.append((box, track_id, model.names[int(b.cls[0])]))
            else:
                x1, y1, x2, y2 = box      # animal peu sûr : on protège juste sa zone
                cv2.rectangle(person_mask, (x1, y1), (x2, y2), 255, -1)

        # 2. Personnes : reconnaissance faciale + mémoire du suivi
        faces = face_engine.detect(frame) if persons else []
        detections = []   # (cadre, statut, texte, clé de suivi, cause, stable)
        for box, track_id in persons:
            track = tracks.setdefault(track_id, new_track()) if track_id is not None else new_track()
            track["last_seen"] = now
            track["frames"] += 1
            status = classify_person(track, box, faces, face_engine, frame, now)

            # Une ligne face_sightings par apparition (mise à jour si le statut change)
            stable = track["frames"] >= MIN_TRACK_FRAMES
            if (db and track_id is not None and stable and status != "analysing"
                    and status != track["recorded"]):
                track["recorded"] = status
                db.submit("sighting", track["key"], track["person_id"],
                          track["similarity"], status, track_id)

            color, text = STYLE[status]
            label = text or track["name"]
            if SHOW_SCORES and track["debug"]:
                label = f"{label} [{track['debug']}]"
            cause = "personne inconnue" if status == "unknown" else "personne sans visage visible"
            detections.append((box, status, label, track["key"], cause, stable))

        # 3. Animaux : pas de visage analysable
        for box, track_id, name in animals:
            key = f"animal-{track_id}" if track_id is not None else None
            animal_frames[key] = animal_frames.get(key, 0) + 1
            stable = key is not None and animal_frames[key] >= MIN_TRACK_FRAMES
            detections.append((box, "unidentified", "NON IDENTIFIE", key, f"animal ({name})", stable))

        # 4. Objets qui bougent (hors personnes et animaux)
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        mask = background.apply(gray)
        moving_objects = []
        if frame_count > MOTION_WARMUP:
            _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
            if cv2.countNonZero(mask) / mask.size > MOTION_MAX_RATIO:
                motion_frames = 0          # changement de lumière : pas un objet
            else:
                mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
                # On retire le mouvement des personnes (leur silhouette) et des animaux :
                # ce qui bouge en dehors = un objet, même s'il est tenu à la main
                covered = person_mask
                if SILHOUETTE_MARGIN:
                    size = 2 * SILHOUETTE_MARGIN + 1
                    covered = cv2.dilate(person_mask, np.ones((size, size), np.uint8))
                for (x1, y1, x2, y2), _, _ in animals:
                    cv2.rectangle(covered, (x1 - BOX_MARGIN, y1 - BOX_MARGIN),
                                  (x2 + BOX_MARGIN, y2 + BOX_MARGIN), 255, -1)
                mask = cv2.bitwise_and(mask, cv2.bitwise_not(covered))
                mask = cv2.dilate(mask, kernel, iterations=2)
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for c in contours:
                    if cv2.contourArea(c) < MOTION_MIN_AREA:
                        continue
                    x, y, w, h = cv2.boundingRect(c)
                    moving_objects.append((x, y, x + w, y + h))
                motion_frames = motion_frames + 1 if moving_objects else 0
        # Un objet n'est signalé que s'il bouge plusieurs images de suite
        if motion_frames >= MOTION_PERSIST:
            for box in moving_objects:
                detections.append((box, "unidentified", "NON IDENTIFIE", None,
                                   "objet en mouvement", True))

        tracks = {k: v for k, v in tracks.items() if now - v["last_seen"] < TRACK_TIMEOUT}
        ms = (time.perf_counter() - t0) * 1000

        # 5. Dessin
        for (x1, y1, x2, y2), status, text, *_ in detections:
            if status == "analysing":
                continue          # pendant l'analyse : aucun cadre
            color = STYLE[status][0]
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, text, (x1, max(y1 - 8, 15)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        times.append(ms)
        times = times[-30:]
        avg_ms = sum(times) / len(times)

        # 6. Alertes : UNE seule par apparition (personne ou animal suivi),
        #    et au plus une toutes les 30 s pour les objets qui bougent
        new_alerts = {"unknown_person": [], "unidentified": []}
        object_seen = False
        for _, status, label, key, cause, stable in detections:
            # Une détection trop courte (quelques images) est souvent une fausse détection
            if status not in ("unknown", "unidentified") or not stable:
                continue
            alert_type = "unknown_person" if status == "unknown" else "unidentified"
            if key is None:
                object_seen = True
            elif (key, status) not in alerted:
                alerted[(key, status)] = now
                new_alerts[alert_type].append((label, key, cause))
        if object_seen and now - last_object_alert > OBJECT_ALERT_COOLDOWN:
            last_object_alert = now
            new_alerts["unidentified"].append(("NON IDENTIFIE", None, "objet en mouvement"))
        for alert_type, items in new_alerts.items():
            if items:
                labels = [label for label, _, _ in items]
                keys = [key for _, key, _ in items if key and not key.startswith("animal-")]
                causes = [cause for _, _, cause in items]
                threading.Thread(target=send_alert, args=(alert_type, labels, keys, causes),
                                 daemon=True).start()
        animal_frames = {k: v for k, v in animal_frames.items()
                         if any(d[3] == k for d in detections)}
        alerted = {k: t for k, t in alerted.items() if now - t < 600}

        if writer:
            writer.write(frame)

        # 7. Image pour le dashboard
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            with frame_lock:
                latest_jpeg = jpg.tobytes()

        # 8. Fenêtre locale (touche q pour quitter)
        if SHOW_WINDOW:
            cv2.imshow("Sentinel-X Vision", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    cap.release()
    if writer:
        writer.release()
        print(f"[INFO] Vidéo enregistrée : {SAVE_FILE}")
    cv2.destroyAllWindows()
    print(f"[INFO] Arrêt. Temps moyen : {avg_ms:.0f} ms/image")
    os._exit(0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sentinel-X - module vision")
    parser.add_argument("--video", help="Analyser un fichier vidéo au lieu de la webcam")
    parser.add_argument("--save", help="Enregistrer la vidéo annotée (ex: resultat.mp4)")
    cli = parser.parse_args()
    VIDEO_FILE, SAVE_FILE = cli.video, cli.save

    ensure_models()
    reload_known_faces()
    threading.Thread(target=reload_loop, daemon=True).start()
    threading.Thread(target=run_server, daemon=True).start()
    try:
        vision_loop()
    except KeyboardInterrupt:
        print("\n[INFO] Arrêt demandé (Ctrl + C).")
        os._exit(0)
