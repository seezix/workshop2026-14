"""
SENTINEL-X - Alertes envoyées à l'API
- L'IA détecte, le backend décide : vision.py n'envoie que des alertes
- 2 types (format d'origine du module vision) :
    * unknown_person -> personne inconnue (critical)
    * unidentified   -> présence non identifiée : personne sans visage visible,
                        animal ou objet en mouvement (warning)
"""

from datetime import datetime, timezone

import requests

VISIT_GAP = 30 * 60     # Secondes sans voir quelqu'un avant de compter un nouveau passage

ALERT_RULES = {   # type -> (severity, message)
    "unknown_person": ("critical", "Personne inconnue détectée"),
    "unidentified": ("warning", "Présence non identifiée"),
}


def build_payload(alert_type, device_id, labels, causes=None, now=None):
    """Corps de POST /api/v1/alerts : les détections d'une même image sont regroupées."""
    severity, message = ALERT_RULES[alert_type]
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {
        "device_id": device_id,
        "source": "vision",
        "type": alert_type,
        "severity": severity,
        "message": f"{message} ({len(labels)})"[:140],
        "details": {
            "count": len(labels),
            "labels": labels,
            "causes": causes or [],
            "detected_at": moment.isoformat(),
        },
    }


def post_alert(payload, api_url, api_key, verify=True, timeout=2):
    """Envoie l'alerte. Retourne son id, ou None (refusée, ignorée ou API injoignable)."""
    headers = {"X-Api-Key": api_key} if api_key else {}
    try:
        r = requests.post(api_url, json=payload, headers=headers, timeout=timeout, verify=verify)
    except requests.RequestException as e:
        print(f"[ALERTE] Échec de l'envoi : {e}")
        return None
    if r.status_code >= 400:
        print(f"[ALERTE] Refusée par l'API ({r.status_code}) : {r.text[:200]}")
        return None
    try:
        body = r.json()
    except ValueError:
        body = {}
    if body.get("suppressed"):      # boîtier désarmé : trace gardée, pas d'alerte
        print(f"[ALERTE] Ignorée par l'API ({body.get('reason')}) : {payload['type']}")
        return None
    causes = payload.get("details", {}).get("causes") or payload.get("details", {}).get("labels", [])
    print(f"[ALERTE] Envoyée ({r.status_code}) : {payload['type']} -> {', '.join(causes)}")
    return body.get("id")


class VisitLog:
    """Dernier moment où chaque personne a été vue, pour compter les passages."""

    def __init__(self, gap=VISIT_GAP):
        self._gap = gap
        self._last = {}

    def seed(self, key, last_seen):
        """Valeur lue en base ; ne remplace jamais ce que la mémoire sait déjà."""
        self._last.setdefault(key, last_seen)

    def touch(self, key, now):
        """Note que la personne est vue. Vrai si c'est un nouveau passage."""
        previous = self._last.get(key)
        self._last[key] = now
        return previous is None or now - previous > self._gap
