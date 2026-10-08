"""
SENTINEL-X - Enregistrer une personne (enrôlement)
Calcule l'empreinte de 1 à 5 visages et l'enregistre dans persons + face_embeddings.

Utilisation :
  Avec la webcam (aucune photo n'est enregistrée sur le disque) :
    python add_person.py "Fedoua" --camera --consent
    python add_person.py "Fedoua" --camera --camera-index 1 --consent
  Avec des photos :
    python add_person.py "Fedoua" personnes_autorisees/Fedoua.jpg --consent
"""

import argparse
import getpass
import os
import uuid

import cv2
import psycopg
from dotenv import load_dotenv

from faces import (MODEL_VERSION, FaceEngine, embedding_from_image, ensure_models,
                   face_quality, to_db)

load_dotenv()
MAX_EMBEDDINGS = 5


def capture_from_camera(engine, camera_index):
    """Ouvre la webcam. ESPACE = capturer le visage, Q = terminer."""
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        print(f"[ERREUR] Webcam {camera_index} introuvable. Essaie --camera-index 1")
        return []

    print("[INFO] Webcam ouverte. Mets-toi bien en face, visage éclairé.")
    print("       ESPACE = capturer (jusqu'à 5 fois : face, LÉGÈREMENT à gauche, LÉGÈREMENT à droite)")
    print("       Q = terminer")
    embeddings = []
    while len(embeddings) < MAX_EMBEDDINGS:
        ok, frame = cap.read()
        if not ok:
            continue
        frame = cv2.resize(frame, (640, 480))
        faces = engine.detect(frame)
        preview = frame.copy()

        good = len(faces) == 1 and face_quality(faces[0])
        if len(faces) == 1:
            x, y, w, h = map(int, faces[0][:4])
            box_color = (0, 200, 0) if good else (0, 165, 255)
            cv2.rectangle(preview, (x, y), (x + w, y + h), box_color, 2)
        if good:
            message, color = "Visage OK - ESPACE pour capturer", (0, 200, 0)
        elif len(faces) == 1:
            message, color = "Rapproche-toi ou tourne moins la tete", (0, 165, 255)
        elif len(faces) > 1:
            message, color = "Une seule personne devant la camera", (0, 0, 255)
        else:
            message, color = "Aucun visage detecte", (0, 0, 255)

        cv2.putText(preview, message, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        cv2.putText(preview, f"Captures : {len(embeddings)}/{MAX_EMBEDDINGS}  (Q = terminer)",
                    (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        cv2.imshow("Enrolement Sentinel-X", preview)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord(" "):
            if good:
                embeddings.append(engine.embedding(frame, faces[0]))
                print(f"[OK] Capture {len(embeddings)}/{MAX_EMBEDDINGS}")
            else:
                print("[ATTENTION] Capture refusée : un seul visage, bien visible, presque de face.")

    cap.release()
    cv2.destroyAllWindows()
    cv2.waitKey(1)
    return embeddings


def embeddings_from_photos(engine, paths):
    embeddings = []
    for path in paths:
        image = cv2.imread(path)
        if image is None:
            print(f"[ERREUR] Impossible de lire : {path} (format JPEG ou PNG ?)")
            continue
        emb = embedding_from_image(engine, image)
        if emb is None:
            print(f"[ATTENTION] Aucun visage trouvé sur : {path}")
            continue
        embeddings.append(emb)
    return embeddings


def main():
    parser = argparse.ArgumentParser(description="Enregistrer une personne")
    parser.add_argument("nom", help="Nom affiché (display_name)")
    parser.add_argument("photos", nargs="*", help="1 à 5 photos du visage (jpg ou png)")
    parser.add_argument("--camera", action="store_true", help="Capturer avec la webcam")
    parser.add_argument("--camera-index", type=int, default=int(os.getenv("CAMERA_INDEX", "0")),
                        help="Numéro de la webcam (0 = caméra du Mac, 1 = souvent la webcam USB)")
    parser.add_argument("--consent", action="store_true",
                        help="Obligatoire : la personne a donné son accord")
    args = parser.parse_args()

    if not args.consent:
        print("[REFUS] Une personne autorisée doit avoir donné son accord : ajoute --consent")
        return
    if not args.camera and not args.photos:
        print("[REFUS] Donne des photos, ou ajoute --camera pour utiliser la webcam.")
        return
    if len(args.photos) > MAX_EMBEDDINGS:
        print(f"[REFUS] {MAX_EMBEDDINGS} photos maximum par personne.")
        return

    ensure_models()
    engine = FaceEngine()
    if args.camera:
        embeddings = capture_from_camera(engine, args.camera_index)
    else:
        embeddings = embeddings_from_photos(engine, args.photos)

    if not embeddings:
        print("[REFUS] Aucune empreinte valide : personne non enregistrée.")
        return

    person_id = uuid.uuid4()
    # Compte administrateur (le compte vision_service ne peut pas créer de personne autorisée)
    with psycopg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME", "sentinel"),
        user=os.getenv("ADMIN_DB_USER") or getpass.getuser(),
        password=os.getenv("ADMIN_DB_PASSWORD") or None,
    ) as conn:
        conn.execute(
            "INSERT INTO persons (id, display_name, status, consent_at, visit_count) "
            "VALUES (%s, %s, 'authorized', NOW(), 0)",
            (person_id, args.nom),
        )
        for emb in embeddings:
            conn.execute(
                "INSERT INTO face_embeddings (person_id, embedding, model_version, source) "
                "VALUES (%s, %s, %s, 'enrollment')",
                (person_id, to_db(emb), MODEL_VERSION),
            )

    print(f"[OK] {args.nom} enregistré(e) (authorized) avec {len(embeddings)} empreinte(s)")
    print(f"     id : {person_id}")


if __name__ == "__main__":
    main()
