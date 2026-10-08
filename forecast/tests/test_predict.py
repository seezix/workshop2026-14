import json
from datetime import datetime, timezone

import pandas as pd
import pytest
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

import Code_ai_predict as fp
from Code_ai_predict import FEATURES, analyser_ligne, build_payload, etat_hall, post_alert

# Contrat de POST /api/v1/alerts (backend/src/alerts)
BACKEND_SEVERITIES = {"info", "warning", "critical"}
LABELS = {"Normal", "Pluie", "Fuite_De_Gaz", "Incendie", "Evenement_Magnetique"}


class FakeResponse:
    def __init__(self, status_code, body, headers=None):
        self.status_code = status_code
        self._body = body
        self.text = str(body)
        self.headers = headers or {}

    def json(self):
        return self._body


@pytest.fixture(scope="module")
def modele():
    """Modèle sur un petit jeu proche des moyennes de model_reference_data."""
    rows = []
    for label, cluster, temp, hum, hall, gas in [
        ("Normal", 2, 22.0, 47.0, 1.0, 150),
        ("Normal", 0, 19.5, 66.0, 1.0, 150),
        ("Pluie", 0, 17.5, 88.0, 1.0, 150),
        ("Incendie", 1, 89.0, 5.0, 1.0, 956),
        ("Fuite_De_Gaz", 4, 27.4, 44.0, 1.0, 627),
        ("Evenement_Magnetique", 3, 27.5, 44.0, 0.0, 150),
    ]:
        for i in range(5):
            rows.append(dict(temp=temp + i * 0.1, hum=hum + i * 0.1, hall_state=hall,
                             gas=gas + i, cluster_id=cluster, label=label))
    ref = pd.DataFrame(rows)
    scaler = StandardScaler().fit(ref[FEATURES])
    nn = NearestNeighbors(n_neighbors=1).fit(scaler.transform(ref[FEATURES]))
    return ref, scaler, nn


def ligne(**kw):
    base = dict(time=pd.Timestamp("2026-10-08T12:00:00.123456Z"), device_id="SX-001",
                temp_avg=22.0, hum_avg=47.0, gas_avg=150.0,
                mag_avg=512.0, mag_min=510.0, mag_max=514.0)
    base.update(kw)
    return pd.Series(base)


def test_etat_hall_convertit_la_valeur_brute():
    assert etat_hall(512, 508, 515) == 1.0
    assert etat_hall(812, 800, 820) == 0.0
    assert etat_hall(250, 240, 260) == 0.0
    assert etat_hall(512, 300, 515) == 0.0          # aimant approché pendant la période
    assert etat_hall(None, None, None) == 1.0       # capteur absent
    assert etat_hall(float("nan"), float("nan"), float("nan")) == 1.0


def test_mesure_normale_sans_alerte(modele):
    assert analyser_ligne(ligne(), modele) is None


def test_aimant_detecte(modele):
    p = analyser_ligne(ligne(temp_avg=27.5, hum_avg=44.0, mag_avg=812.0,
                             mag_min=800.0, mag_max=820.0), modele)
    assert p["details"]["label"] == "Evenement_Magnetique"
    assert p["severity"] == "warning"


@pytest.mark.parametrize("kw,label,severity", [
    (dict(temp_avg=89.0, hum_avg=5.0, gas_avg=950.0), "Incendie", "critical"),
    (dict(temp_avg=27.4, hum_avg=44.0, gas_avg=630.0), "Fuite_De_Gaz", "warning"),
    (dict(temp_avg=17.5, hum_avg=88.0), "Pluie", "info"),
])
def test_payload_compatible_backend(modele, kw, label, severity):
    p = analyser_ligne(ligne(**kw), modele)
    assert p["device_id"] == "SX-001"
    assert p["source"] == "ml"
    assert p["type"] == "ANOMALY_DETECTED"
    assert p["severity"] == severity and p["severity"] in BACKEND_SEVERITIES
    assert p["occurred_at"] == "2026-10-08T12:00:00.123Z"
    assert len(p["message"]) <= 140
    assert p["details"]["label"] == label
    assert len(json.dumps(p["details"])) <= 4096
    assert set(p) <= {"device_id", "source", "type", "severity", "occurred_at",
                      "message", "details"}
    json.dumps(p)  # sérialisable tel quel (pas de types numpy)


def test_mesure_incomplete_ignoree(modele):
    assert analyser_ligne(ligne(temp_avg=float("nan")), modele) is None


def test_toutes_les_alertes_ont_une_severite_backend():
    assert set(fp.ALERTES) <= LABELS
    assert {v[0] for v in fp.ALERTES.values()} <= BACKEND_SEVERITIES


def test_build_payload_normal():
    now = datetime(2026, 10, 8, tzinfo=timezone.utc)
    assert build_payload("SX-001", now, {}, "Normal", 2, 0.1) is None


def test_post_alert_envoie_la_cle(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse(201, {"id": "alert-1"})

    monkeypatch.setattr(fp.requests, "post", fake_post)
    payload = {"device_id": "SX-001", "details": {"label": "Incendie"}}
    assert post_alert(payload, "http://api/alerts", "k" * 24) == "alert-1"
    url, kwargs = calls[0]
    assert url == "http://api/alerts"
    assert kwargs["headers"] == {"X-Api-Key": "k" * 24}
    assert kwargs["json"] == payload


def test_post_alert_reessaie_sur_429(monkeypatch):
    responses = [FakeResponse(429, {}, {"Retry-After": "0"}), FakeResponse(200, {"id": "a"})]
    monkeypatch.setattr(fp.requests, "post", lambda url, **kw: responses.pop(0))
    payload = {"device_id": "SX-001", "details": {"label": "Incendie"}}
    assert post_alert(payload, "http://api/alerts", "k" * 24) == "a"


def test_post_alert_refusee(monkeypatch):
    monkeypatch.setattr(fp.requests, "post", lambda url, **kw: FakeResponse(400, {}))
    assert post_alert({"device_id": "SX-001", "details": {}}, "http://api", "k") is None


def test_post_alert_api_injoignable(monkeypatch):
    def boom(url, **kw):
        raise fp.requests.ConnectionError("down")

    monkeypatch.setattr(fp.requests, "post", boom)
    assert post_alert({"device_id": "SX-001", "details": {}}, "http://api", "k") is None
