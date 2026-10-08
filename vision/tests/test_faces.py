import numpy as np

from faces import FaceEngine


class FakeRecognizer:
    """Remplace SFace : la ressemblance est le produit scalaire des deux empreintes."""

    def match(self, a, b, _mode):
        return float(np.dot(np.ravel(a), np.ravel(b)))


def engine():
    e = FaceEngine.__new__(FaceEngine)      # sans charger les modèles ONNX
    e.recognizer = FakeRecognizer()
    return e


def vec(x, y=0.0):
    v = np.zeros((1, 128), dtype=np.float32)
    v[0, 0], v[0, 1] = x, y
    return v


def person(name, status, emb):
    return {"person_id": name, "name": name, "status": status, "emb": emb}


def test_authorized_person_is_still_recognised():
    match, infos = engine().identify(vec(1), [person("ada", "authorized", vec(1))])
    assert match["person_id"] == "ada"
    assert infos["auth_score"] == 1.0


def test_denied_person_is_recognised():
    match, infos = engine().identify(vec(1), [person("refuse", "denied", vec(1))])
    assert match is not None and match["status"] == "denied"
    assert infos["auth_score"] == 1.0


def test_denied_person_beats_a_memorised_unknown():
    known = [person("inconnu", "unknown", vec(1)), person("refuse", "denied", vec(0.9, 0.1))]
    match, _ = engine().identify(vec(1), known)
    assert match["person_id"] == "refuse"


def test_authorized_and_denied_too_close_is_ambiguous():
    known = [person("ada", "authorized", vec(1)), person("refuse", "denied", vec(0.98))]
    match, _ = engine().identify(vec(1), known)
    assert match is None
