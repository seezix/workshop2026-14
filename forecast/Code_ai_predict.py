import json
import time
import pandas as pd
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler
from sqlalchemy import create_engine, text

engine = create_engine(
    "postgresql+psycopg://sentinel_ia:dev-ia-1a2b3c4d5e6f7g8h9i0j@127.0.0.1:5432/sentinel",
    connect_args={"connect_timeout": 5},
)
FEATURES = ["temp", "hum", "hall_state", "gas"]

ALERTES = {
    0: ("NORMAL", "Situation sous contrôle. Aucun risque détecté.", "Aucune"),
    1: ("DANGER", "Risque d'incendie ! Température et fumée très élevées.",
        "Notifier l'équipe de sécurité et évacuer"),
    2: ("ATTENTION", "Fort taux d'humidité.", "Vérifier le matériel sensible"),
    3: ("ATTENTION", "Présence de magnétisme.", "Vérifier la provenance"),
    4: ("AVERTISSEMENT", "Présence d'un gaz suspect : fuite de gaz ou incendie possible.",
        "Aérer, vérifier la source, prévenir la sécurité"),
}

def charger_modele():
    ref = pd.read_sql("SELECT * FROM model_reference_data", engine)
    scaler = StandardScaler().fit(ref[FEATURES])
    nn = NearestNeighbors(n_neighbors=1).fit(scaler.transform(ref[FEATURES]))
    return ref, scaler, nn

def analyser_ligne(t, modele):
    ref, scaler, nn = modele
    df = pd.read_sql(
        text('''SELECT temp_avg AS temp, hum_avg AS hum,
                       mag_avg AS hall_state, gas_avg AS gas
                FROM telemetry WHERE "time" = :t'''),
        engine, params={"t": t},
    )
    if df.empty:
        raise ValueError(f"Aucune ligne avec time = {t}")

    dist, idx = nn.kneighbors(scaler.transform(df[FEATURES]))
    cluster = int(ref.iloc[idx[0][0]]["cluster_id"])
    niveau, message, action = ALERTES.get(
        cluster, ("INCONNU", f"Cluster {cluster} non géré", "Vérification manuelle"))

    payload = df.iloc[0].to_dict()
    payload.update(
        cluster_id=cluster,
        distance_euclidienne=round(float(dist[0][0]), 4),
        alerte={"niveau_alerte": niveau, "message": message, "action_requise": action},
    )
    return json.dumps(payload, indent=4, ensure_ascii=False)

def surveiller(intervalle=2):
    modele = charger_modele()
    with engine.connect() as conn:
        dernier = conn.execute(text('SELECT MAX("time") FROM telemetry')).scalar()
    print(f"Surveillance démarrée (dernier time : {dernier})", flush=True)

    while True:
        try:
            with engine.connect() as conn:
                temps = [r[0] for r in conn.execute(
                    text('SELECT "time" FROM telemetry '
                         'WHERE (CAST(:d AS timestamptz) IS NULL '
                         'OR "time" > CAST(:d AS timestamptz)) ORDER BY "time"'),
                    {"d": dernier})]
            for t in temps:
                try:
                    print(analyser_ligne(t, modele), flush=True)
                except Exception as e:
                    print(f"Erreur d'analyse sur time {t} : {e}", flush=True)
                dernier = t  # on avance même en cas d'erreur
        except Exception as e:
            print(f"Erreur de base : {e}", flush=True)
        time.sleep(intervalle)

if __name__ == "__main__":
    surveiller()

