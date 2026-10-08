"""
SENTINEL-X - Captures jointes aux alertes
- Une image JPEG par alerte, écrite sur le disque du boîtier
- Seul le nom du fichier part dans alerts.details.snapshot (GUIDELINES §7.1 : jamais en base)
- Effacées après 24 h
"""

import re
import secrets
import time
from datetime import datetime
from pathlib import Path

SNAPSHOT_MAX_AGE = 24 * 3600    # Secondes avant d'effacer une capture
NAME_PATTERN = re.compile(r"^snap-\d{8}-\d{6}-[0-9a-f]{6}\.jpg$")


def is_valid_name(name):
    """Refuse tout ce qui n'est pas un nom produit par save() (ex : ../../.env)."""
    return bool(NAME_PATTERN.match(name))


def save(folder, jpeg, now=None):
    """Écrit la capture et retourne son nom, ou None si l'écriture échoue."""
    moment = datetime.fromtimestamp(now or time.time())
    # Suffixe aléatoire : deux alertes dans la même seconde, et un nom impossible à deviner
    name = f"snap-{moment:%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.jpg"
    try:
        folder = Path(folder)
        folder.mkdir(exist_ok=True)
        (folder / name).write_bytes(jpeg)
    except OSError as e:
        print(f"[CAPTURE] Écriture impossible : {e}")
        return None
    return name


def purge(folder, now=None, max_age=SNAPSHOT_MAX_AGE):
    """Efface les captures plus vieilles que max_age. Retourne le nombre effacé."""
    limit = (now or time.time()) - max_age
    removed = 0
    for path in Path(folder).glob("snap-*.jpg"):
        try:
            if path.stat().st_mtime < limit:
                path.unlink()
                removed += 1
        except OSError:
            continue        # déjà effacée entre-temps
    return removed
