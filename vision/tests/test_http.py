import threading
import time
import uuid

import numpy as np
import pytest

import vision

KEY = "k" * 24
BODY = {"display_name": "Ada Lovelace", "consent_at": "2026-10-07T14:03:12.481Z",
        "created_by": None, "device_id": None}


def emb(x, y=0.0):
    v = np.zeros((1, 128), dtype=np.float32)
    v[0, 0], v[0, 1] = x, y
    return v


@pytest.fixture
def saved(monkeypatch):
    """Remplace l'écriture en base par une liste."""
    calls = []
    monkeypatch.setattr(vision, "save_enrolled_person", lambda *args: calls.append(args))
    return calls


@pytest.fixture
def client(monkeypatch, saved):
    monkeypatch.setattr(vision, "API_KEY", KEY)
    monkeypatch.setattr(vision, "known_faces", [])
    monkeypatch.setattr(vision, "enroller", vision.Enroller())
    monkeypatch.setattr(vision, "visits", vision.VisitLog())
    return vision.app.test_client()


@pytest.fixture
def camera():
    """Joue le rôle de la boucle vidéo : propose des images à la session ouverte.
    Chaque image avance l'horloge d'une seconde, pour ne pas attendre 20 vraies secondes."""
    stop = threading.Event()
    state = {"faces": 1}

    def run():
        offset = 0.0
        while not stop.is_set():
            session = vision.enroller.current()
            if session and not session.done.is_set():
                offset += 1.0
                session.offer([object()] * state["faces"], lambda f: True,
                              lambda f: emb(1), time.time() + offset)
            time.sleep(0.005)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    yield state
    stop.set()
    thread.join()


def post(client, body=BODY, key=KEY):
    headers = {"X-Api-Key": key} if key else {}
    return client.post("/enroll", json=body, headers=headers)


def test_stream_is_served_on_both_paths():
    rules = {rule.rule for rule in vision.app.url_map.iter_rules()}
    assert {"/video", "/video/stream", "/enroll"} <= rules


def test_enroll_requires_the_service_key(client, saved):
    assert post(client, key=None).status_code == 401
    assert post(client, key="x" * 24).status_code == 401
    assert saved == []
    assert vision.enroller.current() is None


def test_enroll_is_closed_without_configured_key(client, monkeypatch):
    monkeypatch.setattr(vision, "API_KEY", "")
    assert post(client, key="").status_code == 503


def test_enroll_requires_name_and_consent(client, saved):
    assert post(client, {**BODY, "display_name": "  "}).status_code == 422
    assert post(client, {**BODY, "consent_at": None}).status_code == 422
    assert saved == []


def test_enroll_saves_an_authorized_person(client, saved, camera):
    res = post(client)
    assert res.status_code == 201
    data = res.get_json()
    assert data["embeddings"] == 5
    person_id = uuid.UUID(data["person_id"])
    assert set(data) == {"person_id", "embeddings"}       # jamais d'empreinte renvoyée

    saved_id, name, consent_at, created_by, embeddings = saved[0]
    assert (saved_id, name, created_by) == (person_id, "Ada Lovelace", None)
    assert consent_at.year == 2026 and consent_at.tzinfo is not None
    assert len(embeddings) == 5
    assert [k["status"] for k in vision.known_faces] == ["authorized"] * 5
    assert vision.enroller.current() is None


def test_enroll_refuses_when_no_face_is_usable(client, saved, camera):
    camera["faces"] = 0
    res = post(client)
    assert res.status_code == 422
    assert "Aucun visage" in res.get_json()["message"]
    assert saved == [] and vision.known_faces == []
    assert vision.enroller.current() is None


def test_enroll_refuses_a_face_already_registered(client, saved, camera):
    vision.known_faces.append({"person_id": "p", "name": "Ada", "status": "authorized", "emb": emb(1)})
    res = post(client)
    assert res.status_code == 409
    assert "Ada" in res.get_json()["message"]
    assert saved == []


def test_enroll_refuses_a_second_capture(client, saved):
    vision.enroller.start(time.time())
    res = post(client)
    assert res.status_code == 409
    assert saved == []


def test_enroll_reports_a_database_failure(client, monkeypatch, camera):
    def boom(*args):
        raise RuntimeError("base injoignable")

    monkeypatch.setattr(vision, "save_enrolled_person", boom)
    res = post(client)
    assert res.status_code == 500
    assert vision.known_faces == []
    assert vision.enroller.current() is None


def test_snapshot_route_serves_a_saved_capture(client, monkeypatch, tmp_path):
    monkeypatch.setattr(vision, "SNAPSHOT_FOLDER", tmp_path)
    name = vision.snapshots.save(tmp_path, b"\xff\xd8jpeg\xff\xd9")
    r = client.get(f"/video/snapshots/{name}")
    assert r.status_code == 200
    assert r.mimetype == "image/jpeg"
    assert r.data == b"\xff\xd8jpeg\xff\xd9"


def test_snapshot_route_refuses_other_files(client, monkeypatch, tmp_path):
    monkeypatch.setattr(vision, "SNAPSHOT_FOLDER", tmp_path)
    (tmp_path / "secret.jpg").write_bytes(b"x")
    assert client.get("/video/snapshots/secret.jpg").status_code == 404
    assert client.get("/video/snapshots/..%2F.env").status_code == 404


def test_snapshot_route_404_once_purged(client, monkeypatch, tmp_path):
    monkeypatch.setattr(vision, "SNAPSHOT_FOLDER", tmp_path)
    assert client.get("/video/snapshots/snap-20261008-140312-abcdef.jpg").status_code == 404


def test_send_alert_saves_the_capture_and_sends_its_name(monkeypatch, tmp_path):
    monkeypatch.setattr(vision, "SNAPSHOT_FOLDER", tmp_path)
    sent = []
    monkeypatch.setattr(vision, "post_alert", lambda payload, *a, **k: sent.append(payload))
    vision.send_alert("unknown_person", ["Inconnu-1a2b"], [], ["personne inconnue"], b"jpeg")
    name = sent[0]["details"]["snapshot"]
    assert (tmp_path / name).read_bytes() == b"jpeg"
