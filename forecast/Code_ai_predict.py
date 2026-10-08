"""
SENTINEL-X - Service de prévision (anomalies d'environnement)
- Lit les nouvelles mesures de telemetry et les compare au jeu de référence
  (model_reference_data) par plus proche voisin
- L'IA détecte, le backend décide : chaque situation anormale part en
  POST /api/v1/alerts (source "ml", type "ANOMALY_DETECTED"), clé du service
  "anomaly" de SERVICE_API_KEYS (backend/.env)
"""

import logging
import math
import os
import time
from datetime import datetime, timezone

import pandas as pd
import requests
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler
from sqlalchemy import create_engine, text

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass

# Rôle sentinel_ia : lecture de telemetry et model_reference_data uniquement.
DATABASE_URL = os.getenv("DATABASE_URL", "")
API_URL = os.getenv("API_URL", "http://localhost:3000/api/v1/alerts")
API_KEY = os.getenv("API_KEY", "")
TLS_VERIFY = os.getenv("TLS_VERIFY", "true").lower() not in ("false", "0")
INTERVALLE_S = float(os.getenv("INTERVALLE_S", "2"))

# Capteur Hall OH49E : valeur brute de l'ADC (~VCC/2 au repos), un aimant la
# décale. Le jeu de référence, lui, ne connaît que l'état : 1 = repos, 0 = aimant.
MAG_REPOS = int(os.getenv("MAG_REPOS", "512"))
MAG_SEUIL = int(os.getenv("MAG_SEUIL", "100"))

FEATURES = ["temp", "hum", "hall_state", "gas"]

# Étiquette du plus proche voisin -> (severity backend, niveau, message, action)
ALERTES = {
    "Incendie": ("critical", "DANGER", "Risque d'incendie ! Température et fumée très élevées.",
                 "Notifier l'équipe de sécurité et évacuer"),
    "Fuite_De_Gaz": ("warning", "AVERTISSEMENT",
                     "Présence d'un gaz suspect : fuite de gaz ou incendie possible.",
                     "Aérer, vérifier la source, prévenir la sécurité"),
    "Evenement_Magnetique": ("warning", "ATTENTION", "Présence de magnétisme.",
                             "Vérifier la provenance"),
    "Pluie": ("info", "ATTENTION", "Fort taux d'humidité.", "Vérifier le matériel sensible"),
}
# "Normal" : aucune alerte.

log = logging.getLogger("forecast")


def charger_modele(engine):
    ref = pd.read_sql("SELECT temp, hum, hall_state, gas, cluster_id, label "
                      "FROM model_reference_data", engine)
    if ref.empty:
        raise RuntimeError("model_reference_data est vide : lancer npm run db:seed")
    ref["hall_state"] = ref["hall_state"].astype(float)
    scaler = StandardScaler().fit(ref[FEATURES])
    nn = NearestNeighbors(n_neighbors=1).fit(scaler.transform(ref[FEATURES]))
    return ref, scaler, nn


def _absent(v):
    return v is None or (isinstance(v, float) and math.isnan(v))


def etat_hall(mag_avg, mag_min=None, mag_max=None):
    """Valeur brute de l'ADC -> état du jeu de référence (1 = repos, 0 = aimant)."""
    valeurs = [v for v in (mag_avg, mag_min, mag_max) if not _absent(v)]
    if any(abs(v - MAG_REPOS) > MAG_SEUIL for v in valeurs):
        return 0.0
    return 1.0  # capteur absent ou au repos


def classer(mesure, modele):
    """mesure : dict temp, hum, hall_state, gas -> (label, cluster_id, distance)."""
    ref, scaler, nn = modele
    dist, idx = nn.kneighbors(scaler.transform(pd.DataFrame([mesure])[FEATURES]))
    voisin = ref.iloc[idx[0][0]]
    return str(voisin["label"]), int(voisin["cluster_id"]), round(float(dist[0][0]), 4)


def build_payload(device_id, occurred_at, mesure, label, cluster_id, distance):
    """Corps de POST /api/v1/alerts, ou None si la situation est normale."""
    if label not in ALERTES:
        return None
    severity, niveau, message, action = ALERTES[label]
    moment = occurred_at.astimezone(timezone.utc) if occurred_at.tzinfo else \
        occurred_at.replace(tzinfo=timezone.utc)
    return {
        "device_id": device_id,
        "source": "ml",
        "type": "ANOMALY_DETECTED",
        "severity": severity,
        "occurred_at": moment.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "message": message[:140],
        "details": {
            "label": label,
            "niveau_alerte": niveau,
            "action_requise": action,
            "cluster_id": cluster_id,
            "distance_euclidienne": distance,
            "mesures": {k: float(mesure[k]) for k in FEATURES},
        },
    }


def post_alert(payload, api_url, api_key, verify=True, timeout=2):
    """Envoie l'alerte. Retourne son id, ou None (refusée, ignorée ou API injoignable)."""
    headers = {"X-Api-Key": api_key} if api_key else {}
    for essai in range(2):
        try:
            r = requests.post(api_url, json=payload, headers=headers,
                              timeout=timeout, verify=verify)
        except requests.RequestException as e:
            log.error("Échec de l'envoi de l'alerte : %s", e)
            return None
        if r.status_code == 429 and essai == 0:  # limite de débit : on réessaie une fois
            try:
                attente = float(r.headers.get("Retry-After", "1"))
            except ValueError:
                attente = 1.0
            time.sleep(min(attente, 5))
            continue
        break
    if r.status_code >= 400:
        log.error("Alerte refusée par l'API (%s) : %s", r.status_code, r.text[:200])
        return None
    try:
        body = r.json()
    except ValueError:
        body = {}
    if body.get("suppressed"):
        log.info("Alerte ignorée par l'API (%s)", body.get("reason"))
        return None
    log.info("Alerte envoyée (%s) : %s %s -> %s", r.status_code, payload["device_id"],
             payload["details"]["label"], body.get("id"))
    return body.get("id")


def analyser_ligne(row, modele):
    """Ligne de telemetry -> payload d'alerte, ou None si normale ou incomplète."""
    if any(_absent(row[c]) for c in ("temp_avg", "hum_avg", "gas_avg")):
        log.warning("Mesure incomplète ignorée : %s à %s", row["device_id"], row["time"])
        return None
    mesure = {
        "temp": float(row["temp_avg"]),
        "hum": float(row["hum_avg"]),
        "hall_state": etat_hall(row["mag_avg"], row["mag_min"], row["mag_max"]),
        "gas": float(row["gas_avg"]),
    }
    label, cluster_id, distance = classer(mesure, modele)
    # Une ligne par mesure analysée : la trace que le service lit ce que le boîtier capte
    log.info("%s : %.1f °C, %.1f %%, gaz %.0f, hall %.0f -> %s", row["device_id"],
             mesure["temp"], mesure["hum"], mesure["gas"], mesure["hall_state"], label)
    log.debug("%s %s : cluster %s, d=%s", row["device_id"], row["time"], cluster_id, distance)
    return build_payload(row["device_id"], row["time"].to_pydatetime(),
                         mesure, label, cluster_id, distance)


REQUETE = text('''
    SELECT "time", device_id, temp_avg, hum_avg, gas_avg, mag_avg, mag_min, mag_max
    FROM telemetry
    WHERE "time" > :d
    ORDER BY "time", device_id
''')


def surveiller(engine, intervalle=INTERVALLE_S):
    modele = charger_modele(engine)
    with engine.connect() as conn:
        dernier = conn.execute(text('SELECT MAX("time") FROM telemetry')).scalar()
    dernier = dernier or datetime.fromtimestamp(0, timezone.utc)
    log.info("Surveillance démarrée (dernier time : %s) -> %s", dernier, API_URL)

    while True:
        try:
            lignes = pd.read_sql(REQUETE, engine, params={"d": dernier})
            for _, row in lignes.iterrows():
                try:
                    payload = analyser_ligne(row, modele)
                    if payload:
                        post_alert(payload, API_URL, API_KEY, TLS_VERIFY)
                except Exception as e:
                    log.error("Erreur d'analyse sur %s à %s : %s",
                              row["device_id"], row["time"], e)
                dernier = row["time"].to_pydatetime()  # on avance même en cas d'erreur
        except Exception as e:
            log.error("Erreur de base : %s", e)
        time.sleep(intervalle)


def main():
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s [%(levelname)s] %(message)s")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL absent (voir forecast/.env.example)")
    if not API_KEY:
        log.warning("API_KEY absent : l'API refusera les alertes (401)")
    engine = create_engine(DATABASE_URL, connect_args={"connect_timeout": 5})
    surveiller(engine)


if __name__ == "__main__":
    main()
