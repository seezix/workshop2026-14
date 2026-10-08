from datetime import datetime, timezone

import requests

import alerts
from alerts import ALERT_RULES, VisitLog, alert_kind, alert_to_send, build_payload, post_alert

BACKEND_TYPES = {"PERSON_DETECTED", "PERSON_UNKNOWN", "PERSON_RETURNING", "PERSON_DENIED"}


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


def test_rules_only_use_the_backend_contract():
    assert {rule[0] for rule in ALERT_RULES.values()} == BACKEND_TYPES
    assert {rule[1] for rule in ALERT_RULES.values()} <= {"info", "warning", "critical"}
    assert all(len(rule[2]) <= 140 for rule in ALERT_RULES.values())


def test_alert_kind_follows_the_guidelines_table():
    assert alert_kind("authorized") is None
    assert alert_kind("analysing") is None
    assert alert_kind("unknown") == "unknown"
    assert alert_kind("unknown", returning=True) == "returning"
    assert alert_kind("denied", returning=True) == "denied"
    assert alert_kind("unidentified") == "unidentified"
    assert ALERT_RULES["unknown"][:2] == ("PERSON_UNKNOWN", "warning")
    assert ALERT_RULES["returning"][:2] == ("PERSON_RETURNING", "critical")
    assert ALERT_RULES["denied"][:2] == ("PERSON_DENIED", "critical")
    assert ALERT_RULES["unidentified"][:2] == ("PERSON_DETECTED", "warning")


def test_alert_to_send_waits_for_a_stable_track():
    assert alert_to_send("unknown", "unknown", set(), stable=False) is None
    assert alert_to_send("unknown", "unknown", set(), stable=True) == "unknown"


def test_alert_to_send_only_once_per_kind():
    assert alert_to_send("unknown", "unknown", {"unknown"}, stable=True) is None
    assert alert_to_send("unidentified", None, {"unknown"}, stable=True) == "unidentified"


def test_alert_to_send_nothing_for_authorized_or_same_visit():
    assert alert_to_send("authorized", None, set(), stable=True) is None
    assert alert_to_send("analysing", "unknown", set(), stable=True) is None
    assert alert_to_send("unknown", None, set(), stable=True) is None   # même passage


def test_build_payload_matches_post_alerts_body():
    now = datetime(2026, 10, 7, 14, 3, 12, 481000, tzinfo=timezone.utc)
    payload = build_payload("denied", "SX-001", person_id="abc", similarity=0.87654, now=now)
    assert payload == {
        "device_id": "SX-001",
        "source": "vision",
        "type": "PERSON_DENIED",
        "severity": "critical",
        "occurred_at": "2026-10-07T14:03:12.481Z",
        "message": ALERT_RULES["denied"][2],
        "details": {"person_id": "abc", "confidence": 0.877},
    }


def test_build_payload_without_person():
    payload = build_payload("unidentified", "SX-001")
    assert payload["type"] == "PERSON_DETECTED"
    assert payload["details"] == {}


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
