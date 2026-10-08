from datetime import datetime, timezone

import requests

import alerts
from alerts import ALERT_RULES, VisitLog, build_payload, post_alert

BACKEND_TYPES = {"unknown_person", "unidentified"}


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


def test_rules_only_use_the_backend_contract():
    assert set(ALERT_RULES) == BACKEND_TYPES
    assert ALERT_RULES["unknown_person"][0] == "critical"
    assert ALERT_RULES["unidentified"][0] == "warning"
    assert all(len(rule[1]) <= 140 for rule in ALERT_RULES.values())


def test_build_payload_groups_the_detections_of_one_image():
    now = datetime(2026, 10, 7, 14, 3, 12, tzinfo=timezone.utc)
    payload = build_payload("unidentified", "SX-001", ["NON IDENTIFIE", "NON IDENTIFIE"],
                            ["animal (cat)", "objet en mouvement"], now=now)
    assert payload == {
        "device_id": "SX-001",
        "source": "vision",
        "type": "unidentified",
        "severity": "warning",
        "message": "Présence non identifiée (2)",
        "details": {
            "count": 2,
            "labels": ["NON IDENTIFIE", "NON IDENTIFIE"],
            "causes": ["animal (cat)", "objet en mouvement"],
            "detected_at": "2026-10-07T14:03:12+00:00",
        },
    }


def test_build_payload_unknown_person():
    payload = build_payload("unknown_person", "SX-001", ["Inconnu-1a2b"], ["personne inconnue"])
    assert payload["type"] == "unknown_person"
    assert payload["severity"] == "critical"
    assert payload["message"] == "Personne inconnue détectée (1)"


def test_post_alert_sends_the_service_key(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse(201, {"id": "alert-1"})

    monkeypatch.setattr(alerts.requests, "post", fake_post)
    assert post_alert({"type": "PERSON_UNKNOWN"}, "http://api/alerts", "k" * 24) == "alert-1"
    url, kwargs = calls[0]
    assert url == "http://api/alerts"
    assert kwargs["headers"] == {"X-Api-Key": "k" * 24}
    assert kwargs["json"] == {"type": "PERSON_UNKNOWN"}


def test_post_alert_returns_none_when_refused(monkeypatch):
    monkeypatch.setattr(alerts.requests, "post",
                        lambda url, **kw: FakeResponse(401, {"error": {"code": "UNAUTHORIZED"}}))
    assert post_alert({"type": "PERSON_UNKNOWN"}, "http://api/alerts", "") is None


def test_post_alert_returns_none_when_device_is_disarmed(monkeypatch):
    body = {"alert": None, "suppressed": True, "reason": "disarmed"}
    monkeypatch.setattr(alerts.requests, "post", lambda url, **kw: FakeResponse(200, body))
    assert post_alert({"type": "PERSON_UNKNOWN"}, "http://api/alerts", "k" * 24) is None


def test_post_alert_returns_none_when_api_is_down(monkeypatch):
    def fake_post(url, **kwargs):
        raise requests.ConnectionError("refusé")

    monkeypatch.setattr(alerts.requests, "post", fake_post)
    assert post_alert({"type": "PERSON_UNKNOWN"}, "http://api/alerts", "k" * 24) is None


def test_visit_log_counts_a_new_visit_after_the_gap():
    visits = VisitLog(gap=1800)
    assert visits.touch("ada", 1000) is True        # jamais vue
    assert visits.touch("ada", 1500) is False       # même passage
    assert visits.touch("ada", 3299) is False       # 1799 s après la dernière vue
    assert visits.touch("ada", 5100) is True        # 1801 s plus tard


def test_visit_log_seed_does_not_overwrite_memory():
    visits = VisitLog(gap=1800)
    visits.seed("ada", 1000)
    assert visits.touch("ada", 1200) is False       # vue en base il y a 200 s
    visits.seed("ada", 0)                           # rechargement depuis la base
    assert visits.touch("ada", 1300) is False       # la mémoire garde 1200


def test_build_payload_carries_only_the_snapshot_name():
    payload = build_payload("unknown_person", "SX-001", ["Inconnu-1a2b"], ["personne inconnue"],
                            snapshot="snap-20261008-140312-abcdef.jpg")
    assert payload["details"]["snapshot"] == "snap-20261008-140312-abcdef.jpg"


def test_build_payload_without_snapshot_has_no_snapshot_key():
    payload = build_payload("unidentified", "SX-001", ["NON IDENTIFIE"], ["animal (cat)"])
    assert "snapshot" not in payload["details"]
