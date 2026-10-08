"""
SENTINEL-X - Alertes envoyées à l'API (GUIDELINES §6.2 et §8)
- L'IA détecte, le backend décide : vision.py n'envoie que des alertes
- Types autorisés pour la source "vision" : PERSON_DETECTED, PERSON_UNKNOWN,
  PERSON_RETURNING, PERSON_DENIED
"""

from datetime import datetime, timezone

import requests

VISIT_GAP = 30 * 60     # Secondes sans voir quelqu'un avant de compter un nouveau passage

ALERT_RULES = {   # cas -> (type, severity, message)
    "unknown": ("PERSON_UNKNOWN", "warning", "Personne inconnue dans la zone"),
    "returning": ("PERSON_RETURNING", "critical", "Inconnu déjà vu de retour dans la zone"),
    "denied": ("PERSON_DENIED", "critical", "Personne refusée reconnue"),
    "unidentified": ("PERSON_DETECTED", "warning", "Personne sans visage identifiable"),
}


def alert_kind(status, returning=False):
    """Cas d'alerte (clé de ALERT_RULES) pour un statut, None si aucune alerte.
    returning = True : la personne était déjà mémorisée et revient."""
    if status == "unknown":
        return "returning" if returning else "unknown"
    return status if status in ALERT_RULES else None


def alert_to_send(status, identified_kind, alerted, stable):
    """Cas d'alerte à envoyer maintenant pour une personne suivie, sinon None.
    - status : statut affiché (authorized, unknown, denied, unidentified, analysing)
    - identified_kind : cas décidé à l'identification (None = aucune alerte à envoyer)
    - alerted : cas déjà envoyés pour cette apparition
    - stable : la détection dure depuis assez d'images (sinon, souvent une fausse détection)"""
    if not stable:
        return None
    if status == "unidentified":
        kind = "unidentified"
    elif status in ("unknown", "denied"):
        kind = identified_kind
    else:
        kind = None
    return None if kind is None or kind in alerted else kind


def build_payload(kind, device_id, person_id=None, similarity=None, now=None):
    """Corps de POST /api/v1/alerts."""
    alert_type, severity, message = ALERT_RULES[kind]
    details = {}
    if person_id is not None:
        details["person_id"] = str(person_id)
    if similarity is not None:
        details["confidence"] = round(float(similarity), 3)
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {
        "device_id": device_id,
        "source": "vision",
        "type": alert_type,
        "severity": severity,
        "occurred_at": moment.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "message": message,
        "details": details,
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
    print(f"[ALERTE] Envoyée ({r.status_code}) : {payload['type']}")
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
