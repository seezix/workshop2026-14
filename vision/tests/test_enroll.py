import numpy as np

from enroll import Enroller, EnrollSession, find_duplicate

FACE = object()


def emb(x, y=0.0):
    v = np.zeros((1, 128), dtype=np.float32)
    v[0, 0], v[0, 1] = x, y
    return v


def offer(session, now, faces=(FACE,), good=True):
    return session.offer(list(faces), lambda f: good, lambda f: emb(1), now)


def test_collects_until_the_target():
    session = EnrollSession(now=0)
    for second in range(5):
        offer(session, second)
    assert len(session.embeddings) == 5
    assert session.done.is_set() and session.ok


def test_waits_between_two_captures():
    session = EnrollSession(now=0)
    for now in (0.0, 0.1, 0.2, 0.69):
        offer(session, now)
    assert len(session.embeddings) == 1
    offer(session, 0.7)
    assert len(session.embeddings) == 2


def test_refuses_several_faces_no_face_and_bad_quality():
    session = EnrollSession(now=0)
    assert "une seule personne" in offer(session, 1, faces=(FACE, FACE))
    assert "aucun visage" in offer(session, 2, faces=())
    assert "de face" in offer(session, 3, good=False)
    assert session.embeddings == []
    assert not session.done.is_set()


def test_timeout_with_too_few_captures_is_refused():
    session = EnrollSession(now=0)
    offer(session, 1)
    offer(session, 2)
    offer(session, 20)
    assert session.done.is_set() and not session.ok
    assert len(session.embeddings) == 2


def test_timeout_with_the_minimum_is_accepted():
    session = EnrollSession(now=0)
    for second in (1, 2, 3):
        offer(session, second)
    offer(session, 20)
    assert session.done.is_set() and session.ok


def test_nothing_is_captured_once_done():
    session = EnrollSession(now=0)
    for second in range(5):
        offer(session, second)
    offer(session, 6)
    assert len(session.embeddings) == 5


def test_capture_is_a_copy_of_the_embedding():
    shared = emb(1)
    session = EnrollSession(now=0)
    session.offer([FACE], lambda f: True, lambda f: shared, 0)
    shared[0, 0] = 99
    assert session.embeddings[0][0, 0] == 1


def test_only_one_session_at_a_time():
    enroller = Enroller()
    first = enroller.start(0)
    assert first is not None and enroller.current() is first
    assert enroller.start(1) is None
    enroller.release(first)
    assert enroller.current() is None
    assert enroller.start(2) is not None


def test_find_duplicate_among_registered_persons():
    known = [{"name": "Ada", "status": "authorized", "emb": emb(1)},
             {"name": "Bob", "status": "denied", "emb": emb(0, 1)}]
    assert find_duplicate([emb(0.9, 0.1)], known, 0.38) == "Ada"
    assert find_duplicate([emb(0, 1)], known, 0.38) == "Bob"


def test_find_duplicate_ignores_memorised_unknowns_and_other_faces():
    known = [{"name": "Inconnu-1", "status": "unknown", "emb": emb(1)},
             {"name": "Ada", "status": "authorized", "emb": emb(0, 1)}]
    assert find_duplicate([emb(1)], known, 0.38) is None
