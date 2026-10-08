"""
SENTINEL-X - Outils de reconnaissance faciale (partagés)
- YuNet : trouve les visages dans une image
- SFace : transforme un visage en empreinte de 128 nombres
"""

import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODEL_VERSION = "sface_2021dec"   # Écrit dans face_embeddings.model_version
FACE_CONF_MIN = 0.8               # Confiance minimale pour accepter un visage
MATCH_THRESHOLD = 0.38            # Score minimum pour reconnaître une personne
UNKNOWN_MAX_SCORE = 0.28          # En dessous : visage clairement différent de tous les autorisés
MATCH_MARGIN = 0.05               # Écart minimum entre les 2 personnes autorisées les plus proches
MIN_FACE_SIZE = 45                # Taille minimale du visage (pixels) pour l'analyser
QUALITY_SCORE_MIN = 0.9           # Confiance minimale du détecteur pour analyser un visage
MAX_YAW = 0.35                    # Rotation max de la tête (0 = de face, plus = de profil)

MODELS_DIR = Path("models")
YUNET_PATH = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
SFACE_PATH = MODELS_DIR / "face_recognition_sface_2021dec.onnx"
YUNET_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")
SFACE_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_recognition_sface/face_recognition_sface_2021dec.onnx")


def ensure_models():
    """Télécharge les 2 modèles de visage s'ils ne sont pas déjà là."""
    for path, url in ((YUNET_PATH, YUNET_URL), (SFACE_PATH, SFACE_URL)):
        if path.exists() and path.stat().st_size > 100_000:
            continue
        MODELS_DIR.mkdir(exist_ok=True)
        print(f"[INFO] Téléchargement de {path.name}...")
        urllib.request.urlretrieve(url, path)
        if path.stat().st_size < 100_000:
            path.unlink()
            print(f"[ERREUR] Fichier invalide. Télécharge-le à la main ici : {url}")
            print(f"         et mets-le dans le dossier : {MODELS_DIR}/")
            os._exit(1)


class FaceEngine:
    """Détection (YuNet) et reconnaissance (SFace) de visages."""

    def __init__(self):
        self.detector = cv2.FaceDetectorYN.create(
            str(YUNET_PATH), "", (320, 320), FACE_CONF_MIN, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create(str(SFACE_PATH), "")

    def detect(self, image):
        h, w = image.shape[:2]
        self.detector.setInputSize((w, h))
        _, faces = self.detector.detect(image)
        return faces if faces is not None else []

    def embedding(self, image, face):
        """Empreinte du visage : tableau de 128 nombres."""
        aligned = self.recognizer.alignCrop(image, face)
        return self.recognizer.feature(aligned)

    def identify(self, emb, known):
        """Compare une empreinte à la liste connue.
        Retourne (personne reconnue ou None, infos).
        - Les personnes AUTORISÉES passent en priorité : un inconnu mémorisé
          ne peut jamais « voler » la place d'une personne enregistrée.
        - Refuse si deux personnes autorisées se ressemblent trop (ambigu).
        infos = {"best_name", "best_score", "auth_score"} (utile pour régler les seuils)"""
        per_person = {}   # meilleur score de chaque personne
        for entry in known:
            score = float(self.recognizer.match(emb, entry["emb"], cv2.FaceRecognizerSF_FR_COSINE))
            key = entry["person_id"] or entry["name"]
            if key not in per_person or score > per_person[key][1]:
                per_person[key] = (entry, score)

        ranked = sorted(per_person.values(), key=lambda x: x[1], reverse=True)
        authorized = [r for r in ranked if r[0].get("status", "authorized") == "authorized"]
        unknowns = [r for r in ranked if r[0].get("status") == "unknown"]
        infos = {
            "best_name": ranked[0][0]["name"] if ranked else None,
            "best_score": ranked[0][1] if ranked else 0.0,
            "auth_score": authorized[0][1] if authorized else 0.0,
        }

        # 1. Personne autorisée (prioritaire)
        if authorized:
            best, best_score = authorized[0]
            second = authorized[1][1] if len(authorized) > 1 else 0.0
            if best_score >= MATCH_THRESHOLD and best_score - second >= MATCH_MARGIN:
                return best, infos
        # 2. Inconnu déjà mémorisé (revient dans la zone)
        if unknowns and unknowns[0][1] >= MATCH_THRESHOLD:
            return unknowns[0][0], infos
        return None, infos


def face_quality(face):
    """Vrai si le visage est assez grand, net et de face pour être analysé.
    Un visage de profil donne une mauvaise empreinte -> on ne l'analyse pas."""
    x, y, w, h = face[:4]
    right_eye_x, left_eye_x, nose_x = face[4], face[6], face[8]
    if w < MIN_FACE_SIZE or face[14] < QUALITY_SCORE_MIN:
        return False
    eye_dist = abs(left_eye_x - right_eye_x)
    if eye_dist < 0.25 * w:          # yeux trop proches = tête de profil
        return False
    yaw = abs(nose_x - (right_eye_x + left_eye_x) / 2) / eye_dist
    return yaw <= MAX_YAW


def embedding_from_image(engine, image):
    """Empreinte du plus grand visage d'une photo (None si aucun visage)."""
    h, w = image.shape[:2]
    if w > 1280:
        image = cv2.resize(image, (1280, int(h * 1280 / w)))
    faces = engine.detect(image)
    if len(faces) == 0:
        return None
    face = max(faces, key=lambda f: f[2] * f[3])
    if not face_quality(face):
        print("[ATTENTION] Visage trop petit, flou ou de profil sur cette photo.")
        return None
    return engine.embedding(image, face)


def to_db(emb):
    """Empreinte -> liste de 128 nombres (colonne real[])."""
    return [float(x) for x in np.asarray(emb).flatten()]


def from_db(values):
    """Liste de 128 nombres (colonne real[]) -> empreinte utilisable par SFace."""
    return np.asarray(values, dtype=np.float32).reshape(1, -1)
