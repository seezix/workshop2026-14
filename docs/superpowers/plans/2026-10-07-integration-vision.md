# Intégration du module vision (reconnaissance faciale) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** brancher `vision/` sur le back et le front existants : enregistrer une personne autorisée depuis le dashboard avec la caméra du boîtier, et faire remonter la reconnaissance (alertes, passages, flux vidéo) dans le dashboard.

**Architecture :** le back et le front gardent le contrat de `docs/GUIDELINES.md` ; c'est `vision.py` qui s'y aligne. La logique pure (alertes, session d'enregistrement) sort de `vision.py` dans deux petits modules testables sans caméra. `vision.py` expose deux routes HTTP sur un seul port : le flux `/video/stream` et `POST /enroll`, protégé par la clé de service.

**Tech stack :** Python 3.11, OpenCV (YuNet + SFace), Ultralytics YOLO, Flask, psycopg 3, pytest · NestJS 12, drizzle, zod, vitest · React 19, Vite 8.

**Spec :** [`docs/superpowers/specs/2026-10-08-integration-vision-design.md`](../specs/2026-10-08-integration-vision-design.md), résumée dans « Design de référence » ci-dessous. Contrat : `docs/GUIDELINES.md` §6.1, §6.2, §7.3, §8.

## Design de référence

| Sujet | Avant (`feat/vision`) | Après |
|---|---|---|
| Alertes | pas de clé, types `unknown_person` / `unidentified` → `401` | en-tête `X-Api-Key`, types `PERSON_*` |
| Personnes refusées (`denied`) | ignorées par `vision.py` | reconnues en priorité, cadre rouge, alerte critique |
| Animaux, objets en mouvement | alerte `unidentified` | encadrés sur la vidéo, **aucune alerte** |
| Passages (`face_sightings`) | lignes sans personne ni score, refusées par le schéma | une ligne par personne identifiée seulement |
| Nouveau passage | `visit_count` + 1 à chaque suivi | + 1 seulement si pas vue depuis 30 min |
| Flux vidéo | `/video` sur 5001 | `/video` et `/video/stream`, port `VISION_PORT` |
| Enregistrement | script `add_person.py` (accès direct à la base) | `POST /enroll` appelé par le back, capture par la boucle vidéo |
| Compte Postgres | `vision_service`, créé par `sentinel_vision.sql` | `sentinel_vision`, créé par les migrations du back |

Correspondance des alertes (GUIDELINES §8) :

| Cas | `type` | `severity` |
|---|---|---|
| Inconnu, 1er passage | `PERSON_UNKNOWN` | `warning` |
| Inconnu mémorisé, revu après 30 min | `PERSON_RETURNING` | `critical` |
| Personne refusée reconnue | `PERSON_DENIED` | `critical` |
| Personne sans visage exploitable | `PERSON_DETECTED` | `warning` |
| Personne autorisée | aucune alerte | |

Contrat de `POST /enroll` (vision.py, appelé seulement par le back) :

- Requête : en-tête `X-Api-Key: <clé du service vision>`, corps `{ display_name, consent_at, created_by, device_id }`.
- `201 { person_id, embeddings }` : personne `authorized` créée avec 3 à 5 empreintes.
- `401` clé absente ou fausse · `409` capture déjà en cours ou visage déjà enregistré · `422` nom ou accord manquant, ou aucun visage exploitable en 20 s · `500` écriture en base impossible · `503` `API_KEY` non configurée.
- Toutes les erreurs ont la forme `{ "message": "..." }`, que le back relaie déjà au dashboard.

## Global Constraints

- La migration s'appelle **`0006_vision_sightings.sql`** : `0005_model_reference.sql` existe sur `feat/model-reference-data`.
- Types d'alerte vision autorisés, à l'identique : `PERSON_DETECTED`, `PERSON_UNKNOWN`, `PERSON_RETURNING`, `PERSON_DENIED`.
- L'empreinte (`embedding`) n'est jamais renvoyée par une route HTTP ni écrite dans un log.
- Aucune image de visage n'est écrite sur le disque ni envoyée sur le réseau, hors flux vidéo annoté.
- Aucun secret dans Git ni dans la sortie d'une commande : `backend/.env` et `vision/.env` ne sont jamais commités ni affichés.
- Textes dessinés par `cv2.putText` : ASCII seulement (pas d'accents), comme le code existant.
- Commentaires et messages en français, dans le style des fichiers voisins.
- Messages de commit : `type(scope): message` en français, comme l'historique.
- Commandes Python lancées depuis `vision/` avec `venv/Scripts/python` (Windows) ; commandes npm depuis la racine avec `--prefix`.
- `vision/add_person.py` reste inchangé : il sert d'enregistrement de secours par photos sur un PC sans webcam.

## Fichiers

| Fichier | Action | Rôle |
|---|---|---|
| `backend/db/migrations/0006_vision_sightings.sql` | créer | droits de `sentinel_vision` sur `face_sightings` |
| `backend/src/persons/persons.module.ts` | modifier | le relais `/enroll` envoie la clé de service |
| `backend/src/persons/persons.service.spec.ts` | créer | tests du relais |
| `backend/.env.example`, `backend/README.md` | modifier | valeurs de dev de `VISION_URL` |
| `vision/alerts.py` | créer | types d'alerte, charge utile, envoi, passages de 30 min |
| `vision/enroll.py` | créer | session de capture, verrou d'une session à la fois, détection de doublon |
| `vision/faces.py` | modifier | les personnes refusées sont reconnues |
| `vision/vision.py` | modifier | branchement des modules, routes HTTP, configuration |
| `vision/tests/test_alerts.py`, `test_enroll.py`, `test_faces.py`, `test_http.py` | créer | tests pytest sans caméra |
| `vision/requirements-dev.txt` | créer | pytest |
| `vision/.env.example`, `vision/.gitignore` | modifier | nouvelles variables, cache pytest |
| `vision/sentinel_vision.sql` | supprimer | doublon des migrations, mot de passe en dur |
| `frontend/vite.config.ts` | modifier | proxy `/video` vers `vision.py` |
| `frontend/src/pages/PersonsPage.tsx` | modifier | formulaire d'enregistrement, rafraîchissement en direct |
| `README.md` | modifier | lancer le module vision |

---

## Préparation

- [ ] **Se placer sur `feat/vision` avec la migration 0005**

Le code vision n'existe que sur `feat/vision`. Au moment d'écrire ce plan, le dépôt est sur `feat/model-reference-data`.

```bash
git checkout feat/vision
git merge feat/model-reference-data
ls backend/db/migrations
```

Attendu : la liste contient `0005_model_reference.sql` et `vision/vision.py` existe.

- [ ] **Vérifier l'environnement Python**

```bash
cd vision && venv/Scripts/python -c "import cv2, ultralytics, flask, psycopg; print(cv2.__version__)"
```

Attendu : un numéro de version, sans erreur. Sinon : `python -m venv vision/venv` puis `vision/venv/Scripts/python -m pip install -r vision/requirements.txt`.

---

### Task 1 : Migration 0006 et comptes de service en local

**Files :**
- Create : `backend/db/migrations/0006_vision_sightings.sql`
- Modify (non commités) : `backend/.env`, `vision/.env`

**Interfaces :**
- Produces : rôle Postgres `sentinel_vision` connectable ; `SERVICE_API_KEYS=vision=<clé>`, `VISION_URL`, `DB_VISION_PASSWORD` dans `backend/.env` ; `API_KEY`, `VISION_PORT`, `DB_USER=sentinel_vision` dans `vision/.env`.

- [ ] **Step 1 : Générer les secrets de dev sans les afficher**

Depuis la racine du dépôt (Git Bash). Les valeurs sont hexadécimales, donc sans risque pour `sed`.

```bash
KEY=$(openssl rand -hex 24); PW=$(openssl rand -hex 16)
printf '\n# Module vision (dev local)\nSERVICE_API_KEYS=vision=%s\nVISION_URL=http://localhost:5001\nDB_VISION_PASSWORD=%s\n' "$KEY" "$PW" >> backend/.env
sed -i -E "s/^DB_USER=.*/DB_USER=sentinel_vision/; s/^DB_PASSWORD=.*/DB_PASSWORD=$PW/" vision/.env
printf '\nAPI_KEY=%s\nVISION_PORT=5001\n' "$KEY" >> vision/.env
grep -c -E '^(SERVICE_API_KEYS|VISION_URL|DB_VISION_PASSWORD)=' backend/.env
grep -c -E '^(API_KEY|VISION_PORT)=' vision/.env
```

Attendu : `3` puis `2`. Si `backend/.env` contenait déjà `SERVICE_API_KEYS`, fusionner à la main sur une seule ligne (`SERVICE_API_KEYS=vision=...,anomaly=...`).

Le back ne relit pas son `.env` à chaud : arrêter puis relancer `npm --prefix backend run start:dev` s'il tournait.

Ces deux fichiers sont propres à chaque machine. Sur le PC qui a la webcam, refaire les Steps 1, 2 et 5 de cette tâche (sa base et ses `.env` sont distincts).

- [ ] **Step 2 : Activer la connexion de `sentinel_vision`**

```bash
npm --prefix backend run db:roles
```

Attendu : une ligne `- sentinel_vision : mot de passe posé`.

- [ ] **Step 3 : Vérifier que les droits manquent (test qui échoue)**

Le test rejoue ce que fait `vision.py` : insérer un passage, relire son id, le mettre à jour. La transaction est annulée, rien ne reste en base.

```bash
docker exec sx-db psql -U sentinel_vision -d sentinel -c "BEGIN; INSERT INTO persons (id, display_name, status) VALUES ('00000000-0000-4000-8000-000000000001', 'test-droits', 'unknown'); WITH s AS (INSERT INTO face_sightings (time, person_id, device_id, similarity, status_at_time, track_id) VALUES (NOW(), '00000000-0000-4000-8000-000000000001', 'SX-001', 0.5, 'unknown', 1) RETURNING id) UPDATE face_sightings f SET status_at_time = 'authorized' FROM s WHERE f.id = s.id; ROLLBACK;"
```

Attendu : `ERROR:  permission denied for table face_sightings`.

- [ ] **Step 4 : Écrire la migration**

`backend/db/migrations/0006_vision_sightings.sql` :

```sql
-- Sentinel-X : droits manquants de vision.py sur face_sightings.
-- vision.py écrit une ligne par apparition, relit son id (INSERT ... RETURNING id),
-- puis la met à jour quand le statut change ou qu'une alerte lui est rattachée.
-- 0003_roles.sql ne donnait que INSERT : RETURNING et UPDATE étaient refusés.

GRANT SELECT (id) ON face_sightings TO sentinel_vision;
--> statement-breakpoint
GRANT UPDATE (person_id, similarity, status_at_time, alert_id) ON face_sightings TO sentinel_vision;
```

- [ ] **Step 5 : Appliquer et vérifier que le test passe**

```bash
npm --prefix backend run db:migrate
```

Attendu : `→ 0006_vision_sightings.sql (2 instructions)` puis `Migrations à jour.`

Relancer la commande du Step 3. Attendu : `BEGIN`, `INSERT 0 1`, `UPDATE 0`, `ROLLBACK`, sans erreur. (`UPDATE 0` est normal : une requête ne voit pas la ligne qu'elle vient d'insérer ; seul le contrôle des droits compte.)

- [ ] **Step 6 : Commit**

```bash
git add backend/db/migrations/0006_vision_sightings.sql
git commit -m "feat(db): droits de sentinel_vision sur face_sightings"
```

---

### Task 2 : Backend — relais d'enregistrement authentifié

**Files :**
- Modify : `backend/src/persons/persons.module.ts` (import ligne 27, méthode `enroll`)
- Create : `backend/src/persons/persons.service.spec.ts`
- Modify : `backend/.env.example`, `backend/README.md`

**Interfaces :**
- Consumes : `parseServiceKeys(raw): Map<clé, nom>` de `backend/src/config/env.ts`.
- Produces : `POST /api/v1/persons/enroll` répond `{ person_id: string | null, status: 'authorized', embeddings: number | null }` ; le back appelle `POST {VISION_URL}/enroll` avec l'en-tête `x-api-key`.

- [ ] **Step 1 : Écrire les tests qui échouent**

`backend/src/persons/persons.service.spec.ts` :

```ts
import type { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/access.js';
import type { ApiError, ErrorBody } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/database.module.js';
import { PersonsService } from './persons.module.js';

const VISION_KEY = 'v'.repeat(24);
const ENV = {
  VISION_URL: 'http://vision.test:5001',
  SERVICE_API_KEYS: `anomaly=${'a'.repeat(24)},vision=${VISION_KEY}`,
};
const BODY = { display_name: 'Ada Lovelace', consent: true as const };
const ADMIN: Principal = {
  kind: 'user',
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  role: 'admin',
};

function serviceFor(env: Partial<Env>) {
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new PersonsService(
    {} as Database,
    env as Env,
    audit as unknown as AuditService,
  );
  return { service, audit };
}

function visionReplies(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('aurait dû échouer');
}

const messageOf = (err: ApiError) =>
  (err.getResponse() as ErrorBody).error.message;

describe('PersonsService.enroll', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('relaie à vision.py avec la clé du service vision', async () => {
    const fetchMock = visionReplies(201, { person_id: 'p-1', embeddings: 5 });
    const { service, audit } = serviceFor(ENV);

    const result = await service.enroll(BODY, ADMIN, '127.0.0.1');

    expect(result).toEqual({
      person_id: 'p-1',
      status: 'authorized',
      embeddings: 5,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://vision.test:5001/enroll');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      VISION_KEY,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      display_name: 'Ada Lovelace',
      created_by: ADMIN.id,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'person.enroll' }),
    );
  });

  it('remonte le message de vision.py quand la capture échoue', async () => {
    visionReplies(422, { message: 'Aucun visage exploitable' });
    const { service } = serviceFor(ENV);

    const err = await failure(service.enroll(BODY, ADMIN));

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(messageOf(err)).toBe('Aucun visage exploitable');
  });

  it('503 sans clé du service vision, sans appeler vision.py', async () => {
    const fetchMock = visionReplies(201, {});
    const { service } = serviceFor({ ...ENV, SERVICE_API_KEYS: '' });

    const err = await failure(service.enroll(BODY, ADMIN));

    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503 si vision.py est injoignable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { service } = serviceFor(ENV);

    const err = await failure(service.enroll(BODY, ADMIN));

    expect(err.code).toBe('SERVICE_UNAVAILABLE');
  });
});
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

```bash
npm --prefix backend run test -- src/persons
```

Attendu : 2 échecs. « relaie à vision.py… » : `embeddings` absent du résultat. « 503 sans clé… » : `aurait dû échouer` (la méthode appelle vision.py au lieu de refuser). Les deux autres passent déjà.

- [ ] **Step 3 : Implémenter**

Dans `backend/src/persons/persons.module.ts`, remplacer l'import de la configuration :

```ts
import { ENV, type Env, parseServiceKeys } from '../config/env.js';
```

Dans `enroll()`, remplacer le début de la méthode, de `if (!this.env.VISION_URL)` jusqu'à la ligne `headers: { 'content-type': 'application/json' },` incluse, par :

```ts
    // vision.py n'accepte /enroll qu'avec sa propre clé de service : sans elle,
    // n'importe qui sur le réseau pourrait s'ajouter comme personne autorisée.
    const visionKey = [...parseServiceKeys(this.env.SERVICE_API_KEYS)].find(
      ([, name]) => name === 'vision',
    )?.[0];
    if (!this.env.VISION_URL || !visionKey)
      throw new ApiError('SERVICE_UNAVAILABLE', 'Service vision non configuré');
    let res: globalThis.Response;
    try {
      res = await fetch(new URL('/enroll', this.env.VISION_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': visionKey,
        },
```

Et remplacer la dernière ligne de la méthode, `return { person_id: payload.person_id ?? null, status: 'authorized' };`, par :

```ts
    return {
      person_id: payload.person_id ?? null,
      status: 'authorized',
      embeddings:
        typeof payload.embeddings === 'number' ? payload.embeddings : null,
    };
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

```bash
npm --prefix backend run test -- src/persons
npm --prefix backend run typecheck
npm --prefix backend run lint
```

Attendu : 4 tests passent, typecheck et lint sans erreur.

- [ ] **Step 5 : Documenter les valeurs de dev**

Dans `backend/.env.example`, remplacer les deux dernières lignes par :

```bash
# URL interne de vision.py (enregistrement des visages par webcam).
# En dev local : http://localhost:5001 (VISION_PORT de vision/.env).
# La clé envoyée à vision.py est celle du service « vision » de SERVICE_API_KEYS.
VISION_URL=http://vision:8000
```

Dans `backend/README.md`, remplacer la ligne qui commence par `- **\`POST /persons/enroll\`**` par :

```markdown
- **`POST /persons/enroll`** : relayé à `VISION_URL/enroll` avec la clé du service `vision` en `X-Api-Key` (vision.py fait la capture et écrit la personne). `503` si `VISION_URL` ou la clé `vision` de `SERVICE_API_KEYS` manque. La réponse arrive à la fin de la capture (20 s au plus).
```

- [ ] **Step 6 : Commit**

```bash
git add backend/src/persons backend/.env.example backend/README.md
git commit -m "feat(persons): le relais d'enregistrement s'authentifie auprès de vision.py"
```

---

### Task 3 : `vision/alerts.py` — alertes au format du contrat

**Files :**
- Create : `vision/alerts.py`, `vision/tests/test_alerts.py`, `vision/requirements-dev.txt`
- Modify : `vision/.gitignore`

**Interfaces :**
- Produces :
  - `ALERT_RULES: dict[str, tuple[str, str, str]]` — clés `"unknown"`, `"returning"`, `"denied"`, `"unidentified"`.
  - `alert_kind(status: str, returning: bool = False) -> str | None`
  - `alert_to_send(status: str, identified_kind: str | None, alerted: set, stable: bool) -> str | None`
  - `build_payload(kind, device_id, person_id=None, similarity=None, now=None) -> dict`
  - `post_alert(payload, api_url, api_key, verify=True, timeout=2) -> str | None`
  - `VisitLog(gap=VISIT_GAP)` avec `.seed(key, last_seen)` et `.touch(key, now) -> bool`

- [ ] **Step 1 : Installer pytest**

`vision/requirements-dev.txt` :

```
-r requirements.txt
pytest
```

Ajouter à la fin de `vision/.gitignore` :

```
.pytest_cache/
```

```bash
cd vision && venv/Scripts/python -m pip install -r requirements-dev.txt
```

- [ ] **Step 2 : Écrire les tests qui échouent**

`vision/tests/test_alerts.py` :

```python
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
```

- [ ] **Step 3 : Lancer les tests, vérifier l'échec**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_alerts.py -v
```

Attendu : erreur de collecte `ModuleNotFoundError: No module named 'alerts'`.

- [ ] **Step 4 : Implémenter**

`vision/alerts.py` :

```python
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
```

- [ ] **Step 5 : Lancer les tests, vérifier le succès**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_alerts.py -v
```

Attendu : 13 tests passent.

- [ ] **Step 6 : Commit**

```bash
git add vision/alerts.py vision/tests/test_alerts.py vision/requirements-dev.txt vision/.gitignore
git commit -m "feat(vision): alertes au format du contrat de l'API"
```

---

### Task 4 : `vision/faces.py` — reconnaître les personnes refusées

**Files :**
- Modify : `vision/faces.py` (constantes en tête, méthode `FaceEngine.identify`)
- Create : `vision/tests/test_faces.py`

**Interfaces :**
- Produces : `FaceEngine.identify(emb, known)` retourne aussi les personnes de statut `"denied"`, avec la même priorité que les autorisées. `infos["auth_score"]` devient le meilleur score parmi les personnes autorisées **ou refusées**. Signature inchangée.

- [ ] **Step 1 : Écrire les tests qui échouent**

`vision/tests/test_faces.py` :

```python
import numpy as np

from faces import FaceEngine


class FakeRecognizer:
    """Remplace SFace : la ressemblance est le produit scalaire des deux empreintes."""

    def match(self, a, b, _mode):
        return float(np.dot(np.ravel(a), np.ravel(b)))


def engine():
    e = FaceEngine.__new__(FaceEngine)      # sans charger les modèles ONNX
    e.recognizer = FakeRecognizer()
    return e


def vec(x, y=0.0):
    v = np.zeros((1, 128), dtype=np.float32)
    v[0, 0], v[0, 1] = x, y
    return v


def person(name, status, emb):
    return {"person_id": name, "name": name, "status": status, "emb": emb}


def test_authorized_person_is_still_recognised():
    match, infos = engine().identify(vec(1), [person("ada", "authorized", vec(1))])
    assert match["person_id"] == "ada"
    assert infos["auth_score"] == 1.0


def test_denied_person_is_recognised():
    match, infos = engine().identify(vec(1), [person("refuse", "denied", vec(1))])
    assert match is not None and match["status"] == "denied"
    assert infos["auth_score"] == 1.0


def test_denied_person_beats_a_memorised_unknown():
    known = [person("inconnu", "unknown", vec(1)), person("refuse", "denied", vec(0.9, 0.1))]
    match, _ = engine().identify(vec(1), known)
    assert match["person_id"] == "refuse"


def test_authorized_and_denied_too_close_is_ambiguous():
    known = [person("ada", "authorized", vec(1)), person("refuse", "denied", vec(0.98))]
    match, _ = engine().identify(vec(1), known)
    assert match is None
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_faces.py -v
```

Attendu : le premier test passe, les trois autres échouent (la personne refusée est ignorée).

- [ ] **Step 3 : Implémenter**

Dans `vision/faces.py`, ajouter après la ligne `MAX_YAW = 0.35 ...` :

```python
REGISTERED = ("authorized", "denied")   # Personnes enregistrées par un admin (≠ inconnus mémorisés)
```

Dans `FaceEngine.identify`, remplacer tout ce qui suit la boucle `for entry in known:` (de `ranked = sorted(...)` au `return None, infos` final) par :

```python
        ranked = sorted(per_person.values(), key=lambda x: x[1], reverse=True)
        registered = [r for r in ranked if r[0].get("status", "authorized") in REGISTERED]
        unknowns = [r for r in ranked if r[0].get("status") == "unknown"]
        infos = {
            "best_name": ranked[0][0]["name"] if ranked else None,
            "best_score": ranked[0][1] if ranked else 0.0,
            "auth_score": registered[0][1] if registered else 0.0,
        }

        # 1. Personne enregistrée, autorisée ou refusée (prioritaire)
        if registered:
            best, best_score = registered[0]
            second = registered[1][1] if len(registered) > 1 else 0.0
            if best_score >= MATCH_THRESHOLD and best_score - second >= MATCH_MARGIN:
                return best, infos
        # 2. Inconnu déjà mémorisé (revient dans la zone)
        if unknowns and unknowns[0][1] >= MATCH_THRESHOLD:
            return unknowns[0][0], infos
        return None, infos
```

Dans la docstring de `identify`, remplacer les deux lignes sur les personnes autorisées par :

```python
        - Les personnes ENREGISTRÉES (autorisées ou refusées) passent en priorité :
          un inconnu mémorisé ne peut jamais « voler » la place d'une personne enregistrée.
        - Refuse si deux personnes enregistrées se ressemblent trop (ambigu).
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_faces.py -v
```

Attendu : 4 tests passent.

- [ ] **Step 5 : Commit**

```bash
git add vision/faces.py vision/tests/test_faces.py
git commit -m "feat(vision): reconnaît les personnes refusées"
```

---

### Task 5 : `vision/enroll.py` — session d'enregistrement

**Files :**
- Create : `vision/enroll.py`, `vision/tests/test_enroll.py`

**Interfaces :**
- Produces :
  - constantes `ENROLL_TARGET = 5`, `ENROLL_MINIMUM = 3`, `ENROLL_TIMEOUT = 20`, `ENROLL_GAP = 0.7`
  - `EnrollSession(now, target=…, minimum=…, timeout=…, gap=…)` avec `.embeddings: list`, `.done: threading.Event`, `.ok: bool`, `.offer(faces, quality, embed, now) -> str`
  - `Enroller()` avec `.start(now) -> EnrollSession | None`, `.current() -> EnrollSession | None`, `.release(session)`
  - `find_duplicate(embeddings, known, threshold) -> str | None`

- [ ] **Step 1 : Écrire les tests qui échouent**

`vision/tests/test_enroll.py` :

```python
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
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_enroll.py -v
```

Attendu : erreur de collecte `ModuleNotFoundError: No module named 'enroll'`.

- [ ] **Step 3 : Implémenter**

`vision/enroll.py` :

```python
"""
SENTINEL-X - Enregistrement d'une personne par la caméra du boîtier
- La route POST /enroll ouvre une session
- La boucle vidéo, qui tient la caméra, lui propose chaque image
- La session garde 3 à 5 empreintes d'un visage seul et bien de face
Aucune image n'est gardée : seulement les empreintes.
"""

import threading

import numpy as np

ENROLL_TARGET = 5       # Empreintes visées (comme add_person.py)
ENROLL_MINIMUM = 3      # En dessous : enregistrement refusé
ENROLL_TIMEOUT = 20     # Secondes laissées à la personne (le backend coupe à 30 s)
ENROLL_GAP = 0.7        # Secondes entre deux captures (le temps de bouger un peu la tête)


class EnrollSession:
    """Une capture en cours. offer() est appelé par la boucle vidéo, done est attendu par /enroll."""

    def __init__(self, now, target=ENROLL_TARGET, minimum=ENROLL_MINIMUM,
                 timeout=ENROLL_TIMEOUT, gap=ENROLL_GAP):
        self.embeddings = []
        self.done = threading.Event()
        self._deadline = now + timeout
        self._last_capture = None
        self._target, self._minimum, self._gap = target, minimum, gap

    @property
    def ok(self):
        return len(self.embeddings) >= self._minimum

    def offer(self, faces, quality, embed, now):
        """Propose une image : faces = visages détectés, quality(face) -> bool,
        embed(face) -> empreinte. Retourne le texte à afficher sur la vidéo."""
        if self.done.is_set():
            return "ENREGISTREMENT TERMINE"
        if now >= self._deadline:
            self.done.set()
            return "ENREGISTREMENT TERMINE"
        count = f"ENREGISTREMENT {len(self.embeddings)}/{self._target}"
        if len(faces) > 1:
            return f"{count} - une seule personne"
        if len(faces) == 0:
            return f"{count} - aucun visage"
        if not quality(faces[0]):
            return f"{count} - rapprochez-vous, de face"
        if self._last_capture is None or now - self._last_capture >= self._gap:
            self.embeddings.append(np.array(embed(faces[0]), copy=True))
            self._last_capture = now
            if len(self.embeddings) >= self._target:
                self.done.set()
                return "ENREGISTREMENT TERMINE"
        return f"ENREGISTREMENT {len(self.embeddings)}/{self._target} - bougez legerement la tete"


class Enroller:
    """Une seule session à la fois, partagée entre la route /enroll et la boucle vidéo."""

    def __init__(self):
        self._lock = threading.Lock()
        self._session = None

    def start(self, now):
        """Ouvre une session, ou retourne None si une autre est en cours."""
        with self._lock:
            if self._session is not None:
                return None
            self._session = EnrollSession(now)
            return self._session

    def current(self):
        """Session ouverte, même terminée, tant que /enroll n'a pas fini d'écrire en base."""
        return self._session

    def release(self, session):
        with self._lock:
            if self._session is session:
                self._session = None


def cosine(a, b):
    """Ressemblance de deux empreintes (même calcul que SFace en mode FR_COSINE)."""
    a = np.asarray(a, dtype=np.float32).ravel()
    b = np.asarray(b, dtype=np.float32).ravel()
    norm = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b) / norm if norm else 0.0


def find_duplicate(embeddings, known, threshold):
    """Nom de la personne enregistrée (autorisée ou refusée) qui a déjà ce visage, sinon None.
    Deux fiches pour le même visage seraient ambiguës : la personne ne serait plus reconnue."""
    for entry in known:
        if entry.get("status", "authorized") not in ("authorized", "denied"):
            continue
        if any(cosine(emb, entry["emb"]) >= threshold for emb in embeddings):
            return entry["name"]
    return None
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_enroll.py -v
```

Attendu : 10 tests passent.

- [ ] **Step 5 : Commit**

```bash
git add vision/enroll.py vision/tests/test_enroll.py
git commit -m "feat(vision): session d'enregistrement par la caméra du boîtier"
```

---

### Task 6 : `vision/vision.py` — alertes, passages, personnes refusées

**Files :**
- Modify : `vision/vision.py`, `vision/.env.example`
- Delete : `vision/sentinel_vision.sql`

**Interfaces :**
- Consumes : `VisitLog`, `alert_kind`, `alert_to_send`, `build_payload`, `post_alert` (Task 3) ; `Enroller` (Task 5) ; `identify` avec les refusés (Task 4).
- Produces (globales du module `vision`, utilisées par la Task 7) : `API_KEY: str`, `STREAM_PORT: int`, `visits: VisitLog`, `enroller: Enroller`, `known_faces`, `known_lock`, `db_connect()`, `person_key(entry)`. Chaque suivi (`new_track()`) porte `alert_kind` et `alerted`.

Cette tâche n'a pas de test unitaire propre : la logique testable vit dans `alerts.py` (Task 3). Elle se vérifie par l'import du module, la suite pytest, puis un passage réel (Step 9).

- [ ] **Step 1 : Imports**

Remplacer les lignes `from datetime import datetime, timezone` à `from faces import (...)` (bloc d'imports après `import uuid`) par :

```python
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request
from ultralytics import YOLO

from alerts import VisitLog, alert_kind, alert_to_send, build_payload, post_alert
from enroll import ENROLL_TIMEOUT, Enroller, find_duplicate
from faces import (MATCH_THRESHOLD, MODEL_VERSION, UNKNOWN_MAX_SCORE, FaceEngine,
                   embedding_from_image, ensure_models, face_quality, from_db, to_db)
```

Ajouter `import hmac` entre `import argparse` et `import os`. (`requests` et `timezone` ne servent plus dans ce fichier ; `datetime`, `jsonify`, `request`, `hmac`, `ENROLL_TIMEOUT`, `find_duplicate` et `MATCH_THRESHOLD` servent à la Task 7.)

- [ ] **Step 2 : Configuration**

Remplacer `OBJECT_ALERT_COOLDOWN = 30  # Secondes minimum entre deux alertes "objet qui bouge"` par :

```python
UNIDENTIFIED_ALERT_COOLDOWN = 30  # Secondes minimum entre deux alertes "personne sans visage"
```

Remplacer `STREAM_PORT = 5001` par :

```python
STREAM_PORT = int(os.getenv("VISION_PORT", "5001"))   # flux vidéo + enregistrement
```

Remplacer le bloc de `API_URL = os.getenv(...)` à `PERSON_STATUSES = ("authorized", "unknown")` par :

```python
API_URL = os.getenv("API_URL", "http://192.168.10.1:3000/api/v1/alerts")
API_KEY = os.getenv("API_KEY", "")      # Clé du service "vision" (SERVICE_API_KEYS du backend)
DEVICE_ID = os.getenv("DEVICE_ID", "SX-001")
USE_DB = KNOWN_FACES_SOURCE == "database"

PERSON_CLASS_ID = 0
GREEN, RED, ORANGE, YELLOW = (0, 200, 0), (0, 0, 255), (0, 165, 255), (0, 255, 255)
STYLE = {
    "authorized": (GREEN, None),          # None = afficher le nom
    "unknown": (RED, "PERSONNE INCONNUE"),
    "denied": (RED, "PERSONNE REFUSEE"),
    "unidentified": (ORANGE, "NON IDENTIFIE"),
    "analysing": (YELLOW, "ANALYSE..."),
}
PERSON_STATUSES = ("authorized", "unknown", "denied")
```

Après la ligne `known_lock = threading.Lock()`, ajouter :

```python
visits = VisitLog()         # Dernier passage de chaque personne (nouveau passage après 30 min)
enroller = Enroller()       # Enregistrement en cours demandé par POST /enroll
```

Dans `db_connect()`, remplacer `user=os.getenv("DB_USER", "vision_service"),` par `user=os.getenv("DB_USER", "sentinel_vision"),`.

- [ ] **Step 3 : Chargement des visages connus**

Remplacer la fonction `load_from_database` par :

```python
def load_from_database():
    query = (
        "SELECT p.id, COALESCE(p.display_name, 'Inconnu'), p.status, e.embedding, p.last_seen_at "
        "FROM persons p JOIN face_embeddings e ON e.person_id = p.id "
        "WHERE e.model_version = %s "
        "AND (p.status <> 'authorized' OR p.consent_at IS NOT NULL) "
        "AND (p.expires_at IS NULL OR p.expires_at > NOW())")
    with db_connect() as conn:
        rows = conn.execute(query, (MODEL_VERSION,)).fetchall()
    return [{"person_id": pid, "name": name, "status": status, "emb": from_db(emb),
             "last_seen": seen.timestamp() if seen else None}
            for pid, name, status, emb, seen in rows]
```

Dans `reload_known_faces`, juste après le bloc `with known_lock: known_faces = known`, ajouter (même indentation que `with`) :

```python
        for k in known:
            if k.get("last_seen") is not None:
                visits.seed(person_key(k), k["last_seen"])
```

- [ ] **Step 4 : Envoi des alertes**

Remplacer toute la section, de `ALERT_RULES = {   # type -> (severity, message)` à la fin de la fonction `send_alert` (juste avant `# -------------------- Flux vidéo --------------------`), par :

```python
def send_alert(payload, key):
    """Envoie l'alerte puis rattache son id au passage (face_sightings.alert_id)."""
    alert_id = post_alert(payload, API_URL, API_KEY, TLS_VERIFY)
    if alert_id and db and key:
        db.submit("alert_link", [key], alert_id)


```

- [ ] **Step 5 : Suivi et identification**

Remplacer `new_track` et `reset_identity` par :

```python
def new_track():
    return {"key": uuid.uuid4().hex, "status": None, "person_id": None, "name": None,
            "similarity": None, "unknown_hits": 0.0, "votes": {}, "verified_at": 0.0,
            "mismatches": 0, "recorded": None, "last_seen": 0.0, "debug": "",
            "no_face_since": None, "frames": 0, "alert_kind": None, "alerted": set()}


def reset_identity(track):
    """Oublie l'identité (le suivi s'est trompé de personne)."""
    track.update(status=None, person_id=None, name=None, unknown_hits=0.0,
                 votes={}, mismatches=0, alert_kind=None, alerted=set())
```

Dans `classify_person`, juste après la ligne `if track["status"] in PERSON_STATUSES:`, ajouter :

```python
        visits.touch(track["person_id"] or track["name"], now)   # encore là : même passage
```

Toujours dans `classify_person`, remplacer :

```python
        track.update(status=match["status"], person_id=match["person_id"], name=match["name"])
        if db and match["person_id"]:
            db.submit("visit", match["person_id"], match["status"])
        return track["status"]
```

par :

```python
        track.update(status=match["status"], person_id=match["person_id"], name=match["name"])
        # Nouveau passage = pas vue depuis 30 min : on compte la visite, et on alerte
        # pour un inconnu qui revient ou une personne refusée
        if visits.touch(key, now):
            track["alert_kind"] = alert_kind(match["status"], returning=True)
            if db and match["person_id"]:
                db.submit("visit", match["person_id"], match["status"])
        return track["status"]
```

Et remplacer `track.update(status="unknown", person_id=person_id, name=name)` par :

```python
    track.update(status="unknown", person_id=person_id, name=name, alert_kind="unknown")
    visits.touch(person_id or name, now)
```

- [ ] **Step 6 : Boucle — état, personnes, animaux, objets**

Dans `vision_loop`, remplacer :

```python
    tracks = {}
    alerted = {}              # clé -> moment de l'alerte (une seule alerte par apparition)
    animal_frames = {}        # animal suivi -> nombre d'images où il a été vu
    last_object_alert = 0.0
    motion_frames = 0
```

par :

```python
    tracks = {}
    last_unidentified_alert = 0.0
    motion_frames = 0
```

Remplacer les étapes 2 et 3 de la boucle, de `# 2. Personnes : reconnaissance faciale + mémoire du suivi` jusqu'à la ligne qui précède `# 4. Objets qui bougent (hors personnes et animaux)`, par :

```python
        # 2. Personnes : reconnaissance faciale + mémoire du suivi
        session = enroller.current()
        enroll_text = None
        if session:
            # Enregistrement en cours : la caméra sert à la capture, on n'identifie personne
            enroll_text = session.offer(face_engine.detect(frame), face_quality,
                                        lambda f: face_engine.embedding(frame, f), now)
            persons, tracks = [], {}
        faces = face_engine.detect(frame) if persons else []
        detections = []   # (cadre, statut, texte)
        seen = []         # (suivi, statut, stable) des personnes de cette image
        for box, track_id in persons:
            track = tracks.setdefault(track_id, new_track()) if track_id is not None else new_track()
            track["last_seen"] = now
            track["frames"] += 1
            status = classify_person(track, box, faces, face_engine, frame, now)

            # Une ligne face_sightings par apparition d'une personne identifiée
            # (le schéma exige une personne et un score : rien pour "non identifié")
            stable = track["frames"] >= MIN_TRACK_FRAMES
            if (db and track_id is not None and stable and status in PERSON_STATUSES
                    and track["person_id"] and status != track["recorded"]):
                track["recorded"] = status
                db.submit("sighting", track["key"], track["person_id"],
                          track["similarity"], status, track_id)

            label = STYLE[status][1] or track["name"]
            if SHOW_SCORES and track["debug"]:
                label = f"{label} [{track['debug']}]"
            detections.append((box, status, label))
            seen.append((track, status, stable))

        # 3. Animaux : encadrés sur la vidéo, sans alerte
        for box, _, _ in animals:
            detections.append((box, "unidentified", "NON IDENTIFIE"))

```

À la fin de l'étape 4, remplacer :

```python
        if motion_frames >= MOTION_PERSIST:
            for box in moving_objects:
                detections.append((box, "unidentified", "NON IDENTIFIE", None,
                                   "objet en mouvement", True))
```

par :

```python
        if motion_frames >= MOTION_PERSIST:
            for box in moving_objects:
                detections.append((box, "unidentified", "NON IDENTIFIE"))
```

- [ ] **Step 7 : Boucle — dessin et alertes**

Dans l'étape 5, remplacer `for (x1, y1, x2, y2), status, text, *_ in detections:` par `for (x1, y1, x2, y2), status, text in detections:`.

Juste après la boucle de dessin de l'étape 5 (avant `times.append(ms)`), ajouter :

```python
        if enroll_text:
            cv2.putText(frame, enroll_text, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, YELLOW, 2)

```

Remplacer toute l'étape 6, de `# 6. Alertes : UNE seule par apparition (personne ou animal suivi),` jusqu'à la ligne `alerted = {k: t for k, t in alerted.items() if now - t < 600}` incluse, par :

```python
        # 6. Alertes : une seule par apparition et par cas.
        #    Animaux et objets n'alertent pas : le contrat n'a que des types PERSON_*,
        #    et ceux-ci déclenchent la règle d'intrusion confirmée du backend.
        for track, status, stable in seen:
            kind = alert_to_send(status, track["alert_kind"], track["alerted"], stable)
            if kind is None:
                continue
            if kind == "unidentified":
                if now - last_unidentified_alert < UNIDENTIFIED_ALERT_COOLDOWN:
                    continue
                last_unidentified_alert = now
            track["alerted"].add(kind)
            payload = build_payload(kind, DEVICE_ID, track["person_id"], track["similarity"])
            threading.Thread(target=send_alert, args=(payload, track["key"]), daemon=True).start()
```

- [ ] **Step 8 : En-tête, exemple de configuration, ancien script SQL**

Remplacer la docstring en tête de `vision.py` (lignes 1 à 18) par :

```python
"""
SENTINEL-X - Module Vision (filière IA) - v5 : branché sur l'API et le dashboard
- Lit la webcam USB
- Détecte et SUIT les personnes et les animaux (YOLOv8n-seg + ByteTrack)
- Reconnaît les visages (YuNet + SFace) grâce aux tables persons + face_embeddings
- Repère les objets SEULEMENT s'ils bougent (encadrés, sans alerte)
- Enregistre chaque apparition d'une personne identifiée dans face_sightings
- 4 cas :
    * authorized   -> vert, son nom, pas d'alerte
    * unknown      -> rouge, PERSONNE INCONNUE, alerte (l'inconnu est mémorisé 72 h)
    * denied       -> rouge, PERSONNE REFUSEE, alerte critique
    * unidentified -> orange, NON IDENTIFIE, alerte (pas de visage analysable)
- Sert sur http://<IP_DU_SERVEUR>:5001 (VISION_PORT) :
    * GET  /video/stream : vidéo annotée pour le dashboard
    * POST /enroll       : enregistrement d'une personne, appelé par le backend

Utilisation :
    python vision.py                                   (webcam)
    python vision.py --video test.mp4                  (fichier vidéo)
    python vision.py --video test.mp4 --save out.mp4   (+ enregistre le résultat)
"""
```

Dans `vision_loop`, remplacer `f"Flux : http://localhost:{STREAM_PORT}/video")` par `f"Flux : http://localhost:{STREAM_PORT}/video/stream")`.

Remplacer tout le contenu de `vision/.env.example` par :

```bash
# Copie ce fichier en ".env" et remplis les valeurs (ne jamais mettre .env sur Git)

# Numéro de la webcam USB (0, 1, 2... selon le PC)
CAMERA_INDEX=0

# API du backend. API_KEY = la clé du service "vision" déclarée dans
# SERVICE_API_KEYS=vision=... (backend/.env)
API_URL=http://localhost:3000/api/v1/alerts
API_KEY=a-remplir
TLS_VERIFY=true
DEVICE_ID=SX-001

# Port HTTP de vision.py : flux /video/stream et enregistrement /enroll.
# Doit correspondre à VISION_URL (backend/.env) et au proxy /video de Vite.
VISION_PORT=5001

# Base de données : rôle sentinel_vision, mot de passe = DB_VISION_PASSWORD de backend/.env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=sentinel
DB_USER=sentinel_vision
DB_PASSWORD=a-remplir

# Compte propriétaire de la base : seulement pour add_person.py
# (enregistrement en ligne de commande, par photos ou webcam locale)
ADMIN_DB_USER=
ADMIN_DB_PASSWORD=
```

Supprimer l'ancien script SQL (les tables et le rôle viennent des migrations du back) :

```bash
git rm vision/sentinel_vision.sql
```

- [ ] **Step 9 : Vérifier**

```bash
cd vision && venv/Scripts/python -c "import vision; print('import OK', vision.STREAM_PORT, bool(vision.API_KEY))"
cd vision && venv/Scripts/python -m pytest tests -v
```

Attendu : `import OK 5001 True`, puis 27 tests passent (13 + 4 + 10).

Passage réel, back lancé (`npm --prefix backend run start:dev`) et boîtier `SX-001` armé. Sur un PC avec webcam : `venv/Scripts/python vision.py`. Sans webcam : `venv/Scripts/python vision.py --video <fichier.mp4>` avec une vidéo d'une personne de face.

Attendu dans la console :
- `[INFO] Vision démarrée (boîtier SX-001). Flux : http://localhost:5001/video/stream`
- pour un visage inconnu : `[ALERTE] Envoyée (201) : PERSON_UNKNOWN` (ou `Ignorée par l'API` si le boîtier est désarmé)
- aucune ligne `[BASE] Erreur` ni `[ALERTE] Refusée`

Puis vérifier le passage en base :

```bash
docker exec sx-db psql -U sentinel -d sentinel -c "SELECT status_at_time, similarity, alert_id IS NOT NULL AS alerte FROM face_sightings ORDER BY id DESC LIMIT 3"
```

Attendu : au moins une ligne `unknown` avec un score et `alerte = t`.

- [ ] **Step 10 : Commit**

```bash
git add vision/vision.py vision/.env.example
git commit -m "feat(vision): alertes PERSON_*, passages et personnes refusées selon le contrat"
```

---

### Task 7 : `vision/vision.py` — routes `/video/stream` et `/enroll`

**Files :**
- Modify : `vision/vision.py` (section « Flux vidéo »)
- Create : `vision/tests/test_http.py`

**Interfaces :**
- Consumes : globales de la Task 6 (`API_KEY`, `enroller`, `visits`, `known_faces`, `known_lock`, `db_connect`) ; `ENROLL_TIMEOUT`, `find_duplicate` (Task 5) ; `MATCH_THRESHOLD`, `MODEL_VERSION`, `to_db` (`faces.py`).
- Produces : `save_enrolled_person(person_id, display_name, consent_at, created_by, embeddings)` ; routes `GET /video`, `GET /video/stream`, `POST /enroll` (contrat dans « Design de référence »).

- [ ] **Step 1 : Écrire les tests qui échouent**

`vision/tests/test_http.py` :

```python
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
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

```bash
cd vision && venv/Scripts/python -m pytest tests/test_http.py -v
```

Attendu : les tests qui utilisent `client` échouent à la préparation avec `AttributeError: <module 'vision' ...> has no attribute 'save_enrolled_person'`, et `test_stream_is_served_on_both_paths` échoue (`/video/stream` et `/enroll` absents).

- [ ] **Step 3 : Implémenter**

Dans `vision/vision.py`, remplacer :

```python
@app.route("/video")
def video():
    return Response(generate_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")
```

par :

```python
@app.route("/video")
@app.route("/video/stream")     # chemin attendu par le dashboard (GUIDELINES §6.1)
def video():
    return Response(generate_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")


# -------------------- Enregistrement (appelé par le backend) --------------------
def save_enrolled_person(person_id, display_name, consent_at, created_by, embeddings):
    """Crée la personne autorisée et ses empreintes (tout ou rien).
    L'enregistrement compte comme premier passage : la personne est devant la caméra."""
    with db_connect() as conn:
        with conn.transaction():
            conn.execute(
                "INSERT INTO persons (id, display_name, status, consent_at, created_by, "
                "visit_count) VALUES (%s, %s, 'authorized', %s, %s, 1)",
                (person_id, display_name, consent_at, created_by))
            for emb in embeddings:
                conn.execute(
                    "INSERT INTO face_embeddings (person_id, embedding, model_version, source) "
                    "VALUES (%s, %s, %s, 'enrollment')",
                    (person_id, to_db(emb), MODEL_VERSION))


def refuse(status, message):
    return jsonify({"message": message}), status


@app.route("/enroll", methods=["POST"])
def enroll():
    # Sans cette clé, n'importe qui sur le réseau pourrait s'ajouter comme personne autorisée
    if not API_KEY:
        return refuse(503, "API_KEY absent du .env de vision.py")
    given = request.headers.get("X-Api-Key", "")
    if not hmac.compare_digest(given.encode(), API_KEY.encode()):
        return refuse(401, "Clé de service invalide")
    if not USE_DB:
        return refuse(503, "Enregistrement impossible sans base de données")

    body = request.get_json(silent=True) or {}
    name = str(body.get("display_name") or "").strip()
    if not name or len(name) > 64:
        return refuse(422, "display_name obligatoire (64 caractères max)")
    try:
        consent_at = datetime.fromisoformat(str(body.get("consent_at")).replace("Z", "+00:00"))
    except ValueError:
        return refuse(422, "consent_at obligatoire : la personne doit avoir donné son accord")

    session = enroller.start(time.time())
    if session is None:
        return refuse(409, "Un enregistrement est déjà en cours")
    try:
        # La boucle vidéo remplit la session ; elle la termine à 5 empreintes ou après 20 s
        session.done.wait(ENROLL_TIMEOUT + 5)
        if not session.ok:
            return refuse(422, "Aucun visage exploitable : une seule personne, de face, "
                               "devant la caméra du boîtier")
        with known_lock:
            known = list(known_faces)
        duplicate = find_duplicate(session.embeddings, known, MATCH_THRESHOLD)
        if duplicate:
            return refuse(409, f"Cette personne est déjà enregistrée : {duplicate}")

        person_id = uuid.uuid4()
        try:
            save_enrolled_person(person_id, name, consent_at, body.get("created_by"),
                                 session.embeddings)
        except Exception as e:
            print(f"[BASE] Erreur (enroll) : {e}")
            return refuse(500, "Enregistrement impossible en base")
        visits.seed(person_id, time.time())
        with known_lock:
            known_faces.extend({"person_id": person_id, "name": name,
                                "status": "authorized", "emb": emb}
                               for emb in session.embeddings)
        print(f"[OK] {name} enregistré(e) avec {len(session.embeddings)} empreinte(s)")
        return jsonify({"person_id": str(person_id), "embeddings": len(session.embeddings)}), 201
    finally:
        # La boucle vidéo ne reprend l'identification qu'ici, une fois la personne connue
        enroller.release(session)
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

```bash
cd vision && venv/Scripts/python -m pytest tests -v
```

Attendu : 36 tests passent (27 + 9).

- [ ] **Step 5 : Vérifier sur le programme lancé**

`vision.py` lancé (webcam ou `--video`), depuis la racine du dépôt :

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5001/enroll
curl -s -m 3 -o /dev/null -w "%{content_type}\n" http://localhost:5001/video/stream
```

Attendu : `401`, puis `multipart/x-mixed-replace; boundary=frame` (curl s'arrête au bout de 3 s, c'est voulu : le flux est infini).

- [ ] **Step 6 : Commit**

```bash
git add vision/vision.py vision/tests/test_http.py
git commit -m "feat(vision): routes /video/stream et /enroll protégée par la clé de service"
```

---

### Task 8 : Frontend — enregistrement guidé et liste à jour

**Files :**
- Modify : `frontend/vite.config.ts`
- Modify : `frontend/src/pages/PersonsPage.tsx` (imports, corps de `PersonsPage`, composant `EnrollForm`)

**Interfaces :**
- Consumes : `POST /api/v1/persons/enroll` → `{ person_id, status, embeddings }` (Task 2) ; `GET /video/stream` (Task 7) ; `useStreamEvent` de `frontend/src/live/stream.ts`.

Le front n'a pas de framework de test : la vérification se fait par `lint`, `build` (qui lance `tsc`) et dans le navigateur.

- [ ] **Step 1 : Proxy du flux vidéo**

Dans `frontend/vite.config.ts`, remplacer :

```ts
      // Flux MJPEG de vision.py (servi par nginx en production).
      '/video': 'http://localhost:8080',
```

par :

```ts
      // Flux MJPEG de vision.py (VISION_PORT de vision/.env ; servi par nginx en production).
      '/video': 'http://localhost:5001',
```

- [ ] **Step 2 : Liste des personnes mise à jour en direct**

Dans `frontend/src/pages/PersonsPage.tsx`, remplacer la ligne d'import des types et ajouter l'import du flux :

```tsx
import type { Alert, Person, PersonStatus, Severity, Sighting } from '../api/types'
```

```tsx
import { useStreamEvent } from '../live/stream'
```

(le second import se place après `import { useApi } from '../lib/useApi'`).

Dans `PersonsPage`, juste après la déclaration de `sightings` (le `useApi` qui charge les passages) et **avant** le `if (!can('operator'))`, ajouter :

```tsx
  // Une alerte vision = une personne créée ou revue : la liste se met à jour toute seule.
  useStreamEvent<Alert>('alert.created', (a) => {
    if (a.source !== 'vision') return
    persons.reload()
    sightings.reload()
  })
```

- [ ] **Step 3 : Formulaire d'enregistrement**

Remplacer `{isAdmin && <EnrollForm onDone={persons.reload} />}` par :

```tsx
      {isAdmin && (
        <EnrollForm
          onDone={(personId) => {
            setTab('authorized')
            setSelectedId(personId)
            persons.reload()
          }}
        />
      )}
```

Remplacer tout le composant `EnrollForm` (de `function EnrollForm(` à la fin du fichier) par :

```tsx
interface EnrollResult {
  person_id: string | null
  status: 'authorized'
  embeddings: number | null
}

function EnrollForm({ onDone }: { onDone: (personId: string | null) => void }) {
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const displayName = name.trim()
    setBusy(true)
    setMessage(null)
    try {
      // La réponse n'arrive qu'à la fin de la capture (20 s au plus).
      const result = await api.post<EnrollResult>('/persons/enroll', { display_name: displayName, consent: true })
      const count = result.embeddings
      setMessage(
        count ? `${displayName} enregistré(e) avec ${count} empreinte${count > 1 ? 's' : ''}.` : `${displayName} enregistré(e).`,
      )
      setName('')
      setConsent(false)
      onDone(result.person_id)
    } catch (err) {
      setMessage(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="Enregistrer une personne" className="card flex flex-wrap items-end gap-4">
      <div className="flex-[1_1_100%]">
        <h2 className="m-0 text-lg font-semibold">Enregistrer une personne autorisée</h2>
        <div className="text-sm text-muted">
          La personne se place seule, de face, devant la caméra du boîtier. Cinq empreintes sont capturées en 20 secondes au plus ; aucune photo n'est
          gardée.
        </div>
      </div>
      <label className="fld flex-[1_1_240px]">
        Nom
        <input required maxLength={64} placeholder="Prénom Nom" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex min-h-11 flex-[2_1_320px] items-center gap-2 text-sm">
        <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} />
        La personne a donné son accord (date enregistrée)
      </label>
      <button className="btn btn-p" disabled={!consent || !name.trim() || busy}>
        {busy ? 'Capture en cours…' : 'Lancer la capture'}
      </button>
      {busy && (
        <div className="flex flex-[1_1_100%] flex-col gap-2">
          <p role="status" className="m-0 text-sm font-medium">
            Capture en cours : regardez la caméra du boîtier et bougez légèrement la tête.
          </p>
          <div className="aspect-video w-full max-w-[480px] overflow-hidden rounded-md bg-soft">
            <img src="/video/stream" alt="Flux de la caméra pendant l'enregistrement" className="h-full w-full object-cover" />
          </div>
        </div>
      )}
      {message && !busy && (
        <p role="status" className="m-0 flex-[1_1_100%] text-sm font-medium">
          {message}
        </p>
      )}
    </form>
  )
}
```

- [ ] **Step 4 : Vérifier la compilation**

```bash
npm --prefix frontend run lint
npm --prefix frontend run build
```

Attendu : aucune erreur de lint ni de TypeScript, build terminé.

- [ ] **Step 5 : Vérifier dans le navigateur**

Back et front lancés (`npm --prefix backend run start:dev`, `npm --prefix frontend run dev`), connecté en admin sur `http://localhost:5173/personnes`.

1. `vision.py` **arrêté** : saisir un nom, cocher l'accord, « Lancer la capture ». Attendu : message « Service vision injoignable », le bouton redevient actif.
2. `vision.py` **lancé** (webcam, ou `--video` avec une vidéo d'un visage de face) : même action. Attendu : le flux apparaît dans le formulaire avec « ENREGISTREMENT n/5 », puis « <Nom> enregistré(e) avec 5 empreintes. », l'onglet passe sur « Autorisés » et la personne est sélectionnée.
3. Relancer la capture pour la même personne. Attendu : « Cette personne est déjà enregistrée : <Nom> ».
4. Vue d'ensemble (`http://localhost:5173/`) : la carte « Caméra · flux annoté » affiche la vidéo et le badge « En direct ».

- [ ] **Step 6 : Commit**

```bash
git add frontend/vite.config.ts frontend/src/pages/PersonsPage.tsx
git commit -m "feat(dashboard): enregistrement guidé par le flux et liste des personnes en direct"
```

---

### Task 9 : Documentation et recette de bout en bout

**Files :**
- Modify : `README.md`

- [ ] **Step 1 : Documenter le lancement**

Dans `README.md`, ajouter la ligne `vision/` au bloc « Structure », entre `frontend/` et `docs/` :

```
vision/    Reconnaissance faciale Python (YOLO + YuNet + SFace, port 5001)
```

Ajouter à la fin du fichier :

````markdown
## Module vision (reconnaissance faciale)

`vision.py` lit la webcam du boîtier, reconnaît les visages à partir des tables `persons` et `face_embeddings`, envoie ses alertes au backend et sert le flux annoté au dashboard.

```bash
cd vision
python -m venv venv
venv/Scripts/python -m pip install -r requirements.txt   # venv/bin/python sous Linux et macOS
cp .env.example .env                                      # puis remplir
venv/Scripts/python vision.py                             # ou : vision.py --video test.mp4
```

Trois valeurs relient les `.env` :

| `backend/.env` | `vision/.env` |
|---|---|
| `SERVICE_API_KEYS=vision=<clé>` | `API_KEY=<clé>` |
| `DB_VISION_PASSWORD=<mot de passe>` puis `npm run db:roles` | `DB_USER=sentinel_vision`, `DB_PASSWORD=<mot de passe>` |
| `VISION_URL=http://localhost:5001` | `VISION_PORT=5001` |

- **Enregistrer une personne** : page Personnes du dashboard (rôle admin). La personne se place devant la caméra du boîtier, le backend relaie la demande à `vision.py`.
- **Sans webcam** : `venv/Scripts/python add_person.py "Nom" photo.jpg --consent` enregistre à partir de photos (compte propriétaire de la base, `ADMIN_DB_USER`).
- **Tests** : `venv/Scripts/python -m pip install -r requirements-dev.txt` puis `venv/Scripts/python -m pytest tests`.
````

- [ ] **Step 2 : Suites de tests complètes**

```bash
npm --prefix backend run test
npm --prefix backend run typecheck
npm --prefix frontend run build
cd vision && venv/Scripts/python -m pytest tests
```

Attendu : tout passe (36 tests côté vision).

- [ ] **Step 3 : Recette sur le PC avec webcam**

Base, back, front et `vision.py` lancés, boîtier `SX-001` armé, connecté en admin.

| # | Action | Attendu |
|---|---|---|
| 1 | Une personne non enregistrée se place devant la caméra | Cadre rouge « PERSONNE INCONNUE » ; alerte « Personne inconnue » dans le dashboard ; un « Inconnu #xxxx » apparaît dans l'onglet Inconnus sans recharger la page |
| 2 | Enregistrer cette personne depuis la page Personnes | « ENREGISTREMENT n/5 » sur le flux, puis message de succès ; la personne est dans Autorisés avec 5 empreintes |
| 3 | La personne sort du champ puis revient | Cadre vert avec son nom ; aucune nouvelle alerte ; un passage dans son historique |
| 4 | Passer la personne en « Refusée », lancer la commande ci-dessous, redémarrer `vision.py`, puis revenir devant la caméra | Cadre rouge « PERSONNE REFUSEE » ; alerte critique « Personne refusée » |
| 5 | Se présenter de dos pendant plus de 3 s | Cadre orange « NON IDENTIFIE » ; alerte « Personne détectée » (une seule par 30 s) |
| 6 | Faire bouger un objet, sans personne | Cadre orange sur la vidéo ; **aucune** alerte |
| 7 | Console de `vision.py` pendant toute la recette | Aucune ligne `[BASE] Erreur` ni `[ALERTE] Refusée` |

Commande de la ligne 4. Une alerte n'est envoyée qu'au début d'un nouveau passage (personne non vue depuis 30 min) ; cette commande vieillit le dernier passage pour ne pas attendre :

```bash
docker exec sx-db psql -U sentinel -d sentinel -c "UPDATE persons SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE status = 'denied'"
```

- [ ] **Step 4 : Commit**

```bash
git add README.md
git commit -m "docs: lancer et configurer le module vision"
```

---

## Hors périmètre

- **Capture par la webcam du navigateur** : écartée au design (images de visage sur le réseau, caméra différente de celle qui reconnaît).
- **Fusion d'un inconnu mémorisé avec la personne enregistrée** : si la personne a été vue comme inconnue avant son enregistrement, sa fiche « Inconnu » reste dans l'onglet Inconnus jusqu'à l'effacement automatique à 72 h. Elle n'empêche pas la reconnaissance, les personnes enregistrées étant prioritaires.
- **`docs/GUIDELINES.md` §8** : le tableau des alertes ne décrit pas `PERSON_DETECTED` ni l'absence d'alerte pour les animaux et objets. À mettre à jour par l'équipe qui tient le contrat.
- **Production** : `docker-compose.yml`, nginx (`/video/stream` réservé au rôle viewer) et TLS restent la brique infra.
- **Versions Python** : `requirements.txt` ne fixe aucune version ; l'installation du 2026-10-07 a pris OpenCV 5.0.0. Le figer est une décision à prendre avec l'auteur du module.
