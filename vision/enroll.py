"""
SENTINEL-X - Enregistrement d'une personne par la caméra du boîtier
- La route POST /enroll ouvre une session
- La boucle vidéo, qui tient la caméra, lui propose chaque image
- La session garde 3 à 5 empreintes d'un visage seul et bien de face
Aucune image n'est gardée : seulement les empreintes.
"""

import threading

import numpy as np

ENROLL_TARGET = 5       # Empreintes visées (comme add_person.py)
ENROLL_MINIMUM = 3      # En dessous : enregistrement refusé
ENROLL_TIMEOUT = 20     # Secondes laissées à la personne (le backend coupe à 30 s)
ENROLL_GAP = 0.7        # Secondes entre deux captures (le temps de bouger un peu la tête)


class EnrollSession:
    """Une capture en cours. offer() est appelé par la boucle vidéo, done est attendu par /enroll."""

    def __init__(self, now, target=ENROLL_TARGET, minimum=ENROLL_MINIMUM,
                 timeout=ENROLL_TIMEOUT, gap=ENROLL_GAP):
        self.embeddings = []
        self.done = threading.Event()
        self._deadline = now + timeout
        self._last_capture = None
        self._target, self._minimum, self._gap = target, minimum, gap

    @property
    def ok(self):
        return len(self.embeddings) >= self._minimum

    def offer(self, faces, quality, embed, now):
        """Propose une image : faces = visages détectés, quality(face) -> bool,
        embed(face) -> empreinte. Retourne le texte à afficher sur la vidéo."""
        if self.done.is_set():
            return "ENREGISTREMENT TERMINE"
        if now >= self._deadline:
            self.done.set()
            return "ENREGISTREMENT TERMINE"
        count = f"ENREGISTREMENT {len(self.embeddings)}/{self._target}"
        if len(faces) > 1:
            return f"{count} - une seule personne"
        if len(faces) == 0:
            return f"{count} - aucun visage"
        if not quality(faces[0]):
            return f"{count} - rapprochez-vous, de face"
        if self._last_capture is None or now - self._last_capture >= self._gap:
            self.embeddings.append(np.array(embed(faces[0]), copy=True))
            self._last_capture = now
            if len(self.embeddings) >= self._target:
                self.done.set()
                return "ENREGISTREMENT TERMINE"
        return f"ENREGISTREMENT {len(self.embeddings)}/{self._target} - bougez legerement la tete"


class Enroller:
    """Une seule session à la fois, partagée entre la route /enroll et la boucle vidéo."""

    def __init__(self):
        self._lock = threading.Lock()
        self._session = None

    def start(self, now):
        """Ouvre une session, ou retourne None si une autre est en cours."""
        with self._lock:
            if self._session is not None:
                return None
            self._session = EnrollSession(now)
            return self._session

    def current(self):
        """Session ouverte, même terminée, tant que /enroll n'a pas fini d'écrire en base."""
        return self._session

    def release(self, session):
        with self._lock:
            if self._session is session:
                self._session = None


def cosine(a, b):
    """Ressemblance de deux empreintes (même calcul que SFace en mode FR_COSINE)."""
    a = np.asarray(a, dtype=np.float32).ravel()
    b = np.asarray(b, dtype=np.float32).ravel()
    norm = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b) / norm if norm else 0.0


def find_duplicate(embeddings, known, threshold):
    """Nom de la personne enregistrée (autorisée ou refusée) qui a déjà ce visage, sinon None.
    Deux fiches pour le même visage seraient ambiguës : la personne ne serait plus reconnue."""
    for entry in known:
        if entry.get("status", "authorized") not in ("authorized", "denied"):
            continue
        if any(cosine(emb, entry["emb"]) >= threshold for emb in embeddings):
            return entry["name"]
    return None
