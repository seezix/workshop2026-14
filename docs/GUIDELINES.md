# Sentinel-X : guidelines techniques

> Référence commune de l'équipe pour le workshop M1 (octobre 2026).
> Ce document regroupe les décisions prises jusqu'ici. Il remplace la v0.1 du contrat d'API sur les points marqués **(changé)**.
> Les choix encore à trancher sont listés à la fin, dans « Points ouverts ».

---

## 1. Périmètre

- **Un seul prototype physique** : le boîtier `SX-001`.
- **Architecture prête pour plusieurs boîtiers** : tout est identifié par `device_id` (topics MQTT, base, API). Ajouter un boîtier = flasher un ESP avec un nouvel identifiant + ajouter une ligne dans `devices`, sans changer le code.
- **Pas de gestion de flotte dans l'interface** : pas d'écran d'enregistrement de boîtier, pas de carte, pas de droits par boîtier. Le dashboard utilise `SX-001` comme constante de configuration.
- **`SX-SIM`** : boîtier simulé qui porte un mois d'historique généré pour la démo (vues 30 jours, entraînement IA). Il reste séparé des vraies données.

---

## 2. Architecture générale

```
ESP8266 (SX-001) ──MQTTS :8883──▶ Mosquitto ──▶ Backend ──▶ PostgreSQL + TimescaleDB
       ▲                                         │  ▲
       └──────── cmd / config (MQTT) ────────────┘  │
                                                    ├── SSE + REST ──▶ Dashboard React (nginx :443)
Webcam USB ──▶ vision.py (YOLO + visages) ── POST /alerts ──┘
Service IA (anomalies) ── lit la base, écrit anomaly_scores, POST /alerts
```

- L'ESP ne parle **qu'à Mosquitto**.
- Le backend est **le seul** à écrire les données métier et à pousser vers le dashboard.
- Le flux vidéo annoté de vision.py arrive au dashboard **directement via nginx**.

---

## 3. Stack technique

| Brique | Choix |
|---|---|
| Firmware | C++ (Arduino / PlatformIO), PubSubClient + BearSSL |
| Broker | Mosquitto, TLS uniquement (port 8883), ACL par client |
| Backend | Node.js + TypeScript, NestJS |
| Base | PostgreSQL 16 + TimescaleDB (image `timescale/timescaledb:latest-pg16`) |
| Accès base | Prisma ou Drizzle, avec une migration SQL brute pour Timescale |
| Front | React + Vite + TypeScript, Tailwind + shadcn/ui |
| Graphiques | Apache ECharts (ou uPlot), pas Recharts |
| Temps réel | **SSE** (Server-Sent Events), pas de WebSocket **(changé)** |
| Vision | Python, YOLOv8n + OpenCV (YuNet + SFace pour les visages) |
| Déploiement | Docker Compose, un seul `docker-compose.yml` à la racine |

---

## 4. Conventions communes

- **JSON** en UTF-8, clés en `snake_case`.
- **Unités dans le nom du champ** : `_c` (°C), `_pct` (%), `_ms`, `_s`, `_dbm`.
- **Horodatage** :
  - stockage et API en **UTC**, ISO 8601 avec millisecondes ;
  - les regroupements par jour sont calés sur `Europe/Paris` ;
  - l'ESP n'a pas d'heure fiable : il envoie `uptime_ms` + `seq`, et le backend date à la réception.
- **Versioning** : préfixe `v1` dans les topics (`sentinel/v1/...`) et les routes (`/api/v1/...`).
- **Identifiants** : `device_id` = numéro de série gravé (`SX-001`), UUID générés par le backend pour le reste.

---

## 5. Communication ESP ↔ serveur

### 5.1 Principe : résumé périodique + événements immédiats **(changé)**

L'ESP a trois rythmes indépendants, dans une boucle **non bloquante** (`millis()`, jamais `delay()`) :

| Rythme | Quoi |
|---|---|
| À chaque tour de boucle | Vérification du PIR et du capteur IR (ou interruption) |
| Toutes les 2 s | Lecture des capteurs lents (DHT22, MQ-2), cumul dans le résumé |
| Toutes les `interval_s` secondes | Envoi du résumé (60 s par défaut) |

- Les **détections** (mouvement, IR, montée rapide du gaz) partent **immédiatement**, sans attendre le résumé.
- Le **résumé** ne répète pas les détections, il les compte (`motion_count`, `ir_count`).

### 5.2 Topics

Tous sous `sentinel/v1/{device_id}/` :

| Topic | Sens | QoS | Retain | Usage |
|---|---|---|---|---|
| `telemetry` | ESP → backend | 0 | non | Résumé périodique |
| `events` | ESP → backend | 0 | non | Détections et événements techniques, immédiats |
| `status` | ESP + Last Will → backend | 1 | oui | `online` / `offline` |
| `cmd` | backend → ESP | 1 | non | Action ponctuelle (buzzer, LED) |
| `cmd/ack` | ESP → backend | 0 | non | Accusé d'une commande |
| `config` | backend → ESP | 1 | **oui** | État durable : intervalle, armé / désarmé **(nouveau)** |

**Règle :** une **commande** est une action ponctuelle (faire sonner 3 s). La **config** est un état durable (armé, intervalle). Elle est en retained, donc Mosquitto la renvoie à l'ESP à chaque reconnexion, sans écriture en flash.

**ACL Mosquitto** (username = `device_id`) :

```
pattern write sentinel/v1/%u/telemetry
pattern write sentinel/v1/%u/events
pattern write sentinel/v1/%u/status
pattern write sentinel/v1/%u/cmd/ack
pattern read  sentinel/v1/%u/cmd
pattern read  sentinel/v1/%u/config

user backend
topic read  sentinel/v1/#
topic write sentinel/v1/+/cmd
topic write sentinel/v1/+/config
```

### 5.3 Formats des messages

**telemetry** (résumé de la période) :

```json
{
  "seq": 57,
  "uptime_ms": 3600123,
  "interval_s": 60,
  "samples": 30,
  "temperature_c": { "avg": 23.4, "min": 23.1, "max": 23.9, "last": 23.6 },
  "humidity_pct":  { "avg": 45.1, "min": 44.8, "max": 45.6, "last": 45.2 },
  "gas_raw":       { "avg": 312,  "min": 298,  "max": 355,  "last": 305 },
  "magnetic_raw":  { "avg": 514,  "min": 509,  "max": 760,  "last": 512 },
  "motion_count": 2,
  "ir_count": 3,
  "rssi_dbm": -61
}
```

- `min` / `max` : pour ne jamais rater un pic court.
- `last` : la dernière lecture, pour la tuile « valeur actuelle ».
- `samples` : nombre de lectures valides (des lectures DHT22 ratées le font baisser).
- Une valeur peut être `null` si toutes les lectures de la période ont échoué.

**events** (immédiat) :

```json
{ "seq": 412, "uptime_ms": 3605120, "type": "IR_DETECTED" }
{ "seq": 415, "uptime_ms": 3609870, "type": "IR_CLEARED", "duration_ms": 4750 }
```

Types : `BOOT`, `MOTION_DETECTED`, `IR_DETECTED`, `IR_CLEARED`, `GAS_RISE`, `TAMPER`, `SENSOR_FAILURE` (+ `"sensor": "dht22"`).

**status** (retained) : `{ "state": "online", "fw": "0.1.0", "ip": "192.168.10.20" }`, et le Last Will publie `{ "state": "offline" }`.

**config** (retained) : `{ "interval_s": 60, "armed": true }`

**cmd** : `{ "cmd_id": "c-8f2a91", "action": "BUZZER", "params": { "mode": "beep", "duration_ms": 3000 } }`

| `action` | `params` | Limites appliquées par l'ESP |
|---|---|---|
| `BUZZER` | `mode` : `on`, `off`, `beep` ; `duration_ms` | 10 000 ms max |
| `LED` | `color` : `red`, `green`, `off` ; `blink` : bool | |

**cmd/ack** : `{ "cmd_id": "c-8f2a91", "status": "done" }` ou `"rejected"` avec `"reason"` (`unknown_action`, `invalid_params`, `duplicate`).

### 5.4 Règles firmware

- **`client.setBufferSize(512)`** : le résumé fait environ 280 octets, au-delà de la limite par défaut de PubSubClient (256). Sans ça, le message est rejeté sans erreur visible.
- **Connexion MQTT/TLS persistante**, avec `mqtt.loop()` à chaque tour. Un handshake TLS prend plusieurs secondes sur l'ESP8266 : jamais de reconnexion par message.
- **Interruption minimale** : la fonction d'interruption lève un drapeau (`IRAM_ATTR`), c'est la boucle qui publie. Jamais d'envoi MQTT dans une interruption.
- **Réflexe local** : à une détection, l'ESP réagit **lui-même** (LED, buzzer si armé, OLED), sans attendre le serveur. Ça marche même si le réseau ou le serveur tombe.
- **PIR HC-SR501** : environ 1 min de stabilisation au démarrage, détections ignorées pendant ce temps.
- **Anti-rebond IR** : un message au début de la détection (`IR_DETECTED`), un à la fin avec la durée (`IR_CLEARED`). Jamais un message par lecture.
- **Tampon hors ligne** : les 32 derniers événements non envoyés sont gardés en mémoire et renvoyés à la reconnexion. Le backend recalcule leur heure à partir de `uptime_ms`.
- **Validation de la config** : `interval_s` accepté entre 2 et 300 s, sinon ignoré.
- **Anti-rejeu** : l'ESP garde les 16 derniers `cmd_id` et rejette un doublon.
- **Secrets** dans `include/secrets.h`, ignoré par Git (modèle `secrets.example.h` commité).

---

## 6. API

### 6.1 REST

Toutes les routes passent par nginx en HTTPS. Le dashboard s'authentifie avec un JWT (rôles `viewer`, `operator`, `admin`), les services internes avec `X-Api-Key`.

| Méthode | Route | Rôle | Accès |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | JWT | public |
| `GET` | `/api/v1/devices` | Liste des boîtiers et leur état | viewer |
| `GET` | `/api/v1/devices/{id}` | Détail, état et config | viewer |
| `PUT` | `/api/v1/devices/{id}/config` | `{ interval_s, armed }`, publié en retained | operator |
| `GET` | `/api/v1/devices/{id}/telemetry` | Historique : `from`, `to`, choix automatique brut / 1 h / 1 jour | viewer, IA |
| `GET` | `/api/v1/devices/{id}/stats` | Résumé d'une période : moyennes, extrêmes, nb d'alertes, disponibilité | viewer |
| `GET` | `/api/v1/devices/{id}/events` | Détections et événements | viewer |
| `POST` | `/api/v1/devices/{id}/commands` | Envoi d'une commande → `202 { cmd_id }` | operator |
| `GET` | `/api/v1/devices/{id}/commands` | Historique des commandes | viewer |
| `GET` | `/api/v1/devices/{id}/telemetry/export` | Export CSV | viewer, IA |
| `GET` | `/api/v1/devices/{id}/anomaly-scores` | Historique des scores IA | viewer |
| `GET` | `/api/v1/alerts` | Filtres `status`, `device_id`, `source`, `severity` | viewer |
| `POST` | `/api/v1/alerts` | Point d'entrée unique des alertes | services |
| `PATCH` | `/api/v1/alerts/{id}` | `acknowledged` ou `resolved` | operator |
| `GET` | `/api/v1/persons` | Personnes connues et inconnues (sans empreintes) | operator |
| `GET` | `/api/v1/persons/{id}/sightings` | Historique des passages | operator |
| `PATCH` | `/api/v1/persons/{id}` | Renommer, `authorized` (avec consentement), `denied` | admin |
| `POST` | `/api/v1/persons/enroll` | Enregistrement par la webcam (via vision.py) | admin |
| `DELETE` | `/api/v1/persons/{id}` | Effacement complet | admin |
| `GET` | `/api/v1/stream` | Flux SSE (voir 6.3) | viewer |
| `GET` | `/api/v1/health` | État API, base, broker | réseau local |
| `GET` | `/video/stream` | Flux MJPEG annoté (vision.py via nginx) | viewer |

### 6.2 `POST /api/v1/alerts`

Appelé par le backend (événements ESP, boîtier hors ligne), vision.py et le service d'anomalies.

```json
{
  "device_id": "SX-001",
  "source": "vision",
  "type": "PERSON_UNKNOWN",
  "severity": "warning",
  "occurred_at": "2026-10-07T14:03:12.481Z",
  "message": "Personne inconnue dans la zone",
  "details": { "confidence": 0.87, "person_id": "...", "snapshot": "snap-20261007-140312.jpg" }
}
```

| `source` | `type` |
|---|---|
| `esp` | `MOTION_DETECTED`, `IR_DETECTED`, `GAS_RISE`, `SENSOR_FAILURE`, `TAMPER` |
| `vision` | `PERSON_DETECTED`, `PERSON_UNKNOWN`, `PERSON_RETURNING`, `PERSON_DENIED`, `unknown_person`, `unidentified` (envoyés par vision.py, hors règle d'intrusion) |
| `ml` | `ANOMALY_DETECTED` |
| `system` | `DEVICE_OFFLINE`, `INTRUSION_CONFIRMED` (PIR et vision d'accord dans les 5 s) |

- `201` : nouvelle alerte.
- `200` : doublon (même `device_id` + `source` + `type` dans les 10 dernières secondes), `occurrences` incrémenté.
- Si le boîtier est désarmé, une détection est enregistrée dans `device_events` mais ne crée pas d'alerte.

### 6.3 Envoi de commandes au boîtier **(nouveau)**

Schéma de référence : `docs/sequence-commande.puml`.

**Règle d'or : seul le backend parle à l'ESP.** L'ACL Mosquitto réserve l'écriture sur `cmd` et `config` au compte `backend`. Le front et les services IA passent toujours par l'API.

Parcours d'une commande :

1. Le front appelle `POST /api/v1/devices/{id}/commands` avec son JWT (rôle `operator`).
2. Le backend vérifie le rôle, l'action, les limites des paramètres et que le boîtier est en ligne (sinon `409 DEVICE_OFFLINE`).
3. Il génère le `cmd_id`, enregistre la commande en `pending` et ajoute une ligne dans `audit_log`.
4. Il publie sur `sentinel/v1/{id}/cmd` en QoS 1, **sans retained** (une commande ne doit pas se rejouer à la reconnexion).
5. Il répond **tout de suite** `202 { cmd_id, status: "pending" }`, sans attendre l'ESP.
6. L'ESP vérifie, exécute et publie sur `cmd/ack`.
7. Le backend met à jour la commande (`done` / `rejected`) et pousse `command.updated` par SSE.
8. Sans ack au bout de 5 s, la commande passe en `timeout`.

**Qui peut déclencher une action :**

| Source | Comment | `issuer` | Exemple |
|---|---|---|---|
| Un opérateur | Front → `POST /commands` | `user` | Bouton « Tester l'alarme » |
| Une règle du backend | Interne, après une alerte | `rule:<nom>` | `INTRUSION_CONFIRMED` + armé → buzzer + LED rouge |
| L'ESP lui-même | Réflexe local, sans réseau | (non enregistré) | PIR → LED rouge immédiate |

**L'IA détecte, le backend décide.** vision.py et le service d'anomalies n'envoient pas de commandes : ils envoient des alertes (`POST /alerts`), et ce sont les règles du backend qui déclenchent les actions. Toutes les décisions sont au même endroit, donc faciles à tester, à expliquer et à couper.

**Commande ou config :**

- **Commande** (`POST /commands` → topic `cmd`) : action ponctuelle (faire sonner 3 s).
- **Config** (`PUT /config` → topic `config` en retained) : état durable (armé, intervalle), réappliqué à chaque reconnexion.

### 6.4 Temps réel (SSE)

- Route : `GET /api/v1/stream`.
- Authentification par cookie `httpOnly` (ou `@microsoft/fetch-event-source` avec en-tête).
- nginx : `proxy_buffering off;` sur cette route.
- Les actions de l'utilisateur passent toutes par REST.

| Événement | Quand |
|---|---|
| `telemetry.new` | Nouveau résumé reçu |
| `device_event.new` | Détection ou événement technique |
| `alert.created` / `alert.updated` | Nouvelle alerte, doublon, acquittement |
| `device.status` | En ligne / hors ligne |
| `command.updated` | Ack reçu ou timeout (5 s) |
| `anomaly.score` | Nouveau score IA |

### 6.5 Erreurs

Format unique : `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`.
Codes : `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 DEVICE_OFFLINE`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR` (jamais de stack trace).

---

## 7. Base de données

Schéma de référence : `docs/schema-bdd.puml` (v0.4.1).

### 7.1 Tables

| Table | Rôle |
|---|---|
| `users` | Comptes du dashboard |
| `devices` | Boîtiers, état et **configuration voulue** (`interval_s`, `armed`) |
| `telemetry` (hypertable) | Un résumé par intervalle, une seule table pour tous les capteurs |
| `anomaly_scores` (hypertable) | Scores du modèle IA, avec la version du modèle |
| `model_reference_data` | Jeu de référence du modèle IA de prévision : mesures étiquetées, chargées à l'initialisation |
| `device_events` | Détections et événements techniques |
| `alerts` | Ce qui demande une action humaine |
| `commands` | Commandes et leur accusé. `issuer` (obligatoire) dit qui l'a déclenchée (`user`, `rule:intrusion`...), `issued_by` (facultatif) pointe vers l'utilisateur quand il y en a un |
| `audit_log` | Connexions, échecs, actions sensibles |
| `persons`, `face_embeddings`, `face_sightings` | Reconnaissance faciale (voir section 8) |
| `telemetry_1h`, `telemetry_1d` | Agrégats continus (vues) |

Principes :

- **Une seule table `telemetry`** pour tous les capteurs : une ligne = l'état complet du boîtier sur la période. Pas de table par capteur.
- **`device_events` séparée** : c'est la seule trace des détections immédiates.
- **Images** : jamais en base. Fichiers sur disque (24 h max), seul le nom va dans `alerts.details`.

### 7.2 TimescaleDB

- `telemetry` : compression après 7 jours, rétention 365 jours.
- Agrégats `telemetry_1h` et `telemetry_1d` :
  - moyennes **pondérées** par `samples` (`sum(temp_avg * samples) / sum(samples)`) ;
  - min des `min`, max des `max` ;
  - somme des compteurs ;
  - `materialized_only = false` pour inclure la période en cours ;
  - jour calé sur `Europe/Paris`.
- L'API choisit la source selon la période : brut jusqu'à 24 h, `telemetry_1h` jusqu'à 30 jours, `telemetry_1d` au-delà.
- Après l'insertion de l'historique simulé : `CALL refresh_continuous_aggregate('telemetry_1h', NULL, NULL);` (idem `_1d`), **avant** le passage de la compression.
- Prisma ne gère pas Timescale : hypertables, agrégats et règles de compression/rétention vont dans une migration SQL brute.

### 7.3 Rôles Postgres

| Rôle | Droits |
|---|---|
| `sentinel_app` (backend) | Lecture et écriture sur les tables métier |
| `sentinel_ia` (service d'anomalies) | Lecture des mesures, des agrégats et de `model_reference_data`, écriture dans `anomaly_scores` uniquement |
| `sentinel_vision` (vision.py) | Lecture de `persons` et `face_embeddings`, écriture dans `face_sightings`, création d'inconnus |

Mots de passe : posés par script à partir du `.env`, jamais dans `init.sql`.

---

## 8. Reconnaissance faciale et RGPD

- Un visage utilisé pour identifier une personne est une **donnée biométrique** (article 9 du RGPD).
- **`authorized`** : uniquement des personnes qui ont donné leur accord (membres de l'équipe), avec `consent_at` renseigné.
- **Inconnus** : empreinte seulement, **aucune photo**, suppression automatique après 72 h (`expires_at`).
- **L'empreinte (`embedding`) n'est jamais renvoyée par l'API.**
- **Effacement** : `DELETE /persons/{id}` supprime en cascade empreintes et passages.
- **Performance** : la reconnaissance tourne **une fois par apparition** (suivi YOLO), pas à chaque image, pour tenir les 100 ms par image.
- **Nouveau passage** : personne non vue depuis plus de 30 minutes (`visit_count` + 1).

| Cas | Alerte |
|---|---|
Alertes envoyées par `vision.py` (une par apparition, regroupées par image ; `details` = `count`, `labels`, `causes`, `detected_at`) :

| Cas | Alerte |
|---|---|
| `authorized` ou `denied` reconnu | Aucune (ligne dans `face_sightings`) |
| Inconnu | `unknown_person`, `critical` |
| Personne sans visage visible, animal, objet en mouvement (30 s min entre deux) | `unidentified`, `warning` |

---

## 9. Sécurité (règles côté contrat)

- Aucun port en clair : pas de 1883, pas de HTTP. Tout passe par 8883 ou 443.
- Docker contourne UFW : lier les ports publiés à une IP précise ou passer par la chaîne `DOCKER-USER`.
- Limite de débit : 5 tentatives de login par minute et par IP, 10 alertes par seconde et par service.
- CORS limité à l'origine du dashboard, mots de passe en bcrypt ou argon2.
- L'ESP applique ses propres limites (actions connues, durée de buzzer, bornes de config), même si le backend est compromis.
- Seul le compte MQTT `backend` peut écrire sur `cmd` et `config` : ni le front, ni l'IA, ni un attaquant avec les identifiants de l'ESP ne peuvent piloter le boîtier.
- Chaque commande est tracée dans `commands` (avec son `issuer`) et dans `audit_log`.
- Les tables biométriques sont la cible n°1 du pentest : accès limité aux rôles qui en ont besoin.

---

## 10. Repo et Git

- **Monorepo GitHub privé** pendant la semaine (les autres groupes nous attaquent jeudi).
- Arborescence : `firmware/`, `backend/`, `dashboard/`, `ai/vision/`, `ai/anomaly/`, `infra/` (mosquitto, nginx, postgres, monitoring, certs), `security/`, `tools/fake-esp/`, `docs/`.
- `main` protégée, une branche par fonctionnalité, PR obligatoire.
- Commits au format Conventional Commits avec la brique en scope : `feat(backend): POST /alerts`, `fix(firmware): reconnexion MQTT`.
- `.gitignore` dès le premier commit : `.env`, `secrets.h`, `*.key`, `*.pem`. Protection contre les push de secrets activée sur GitHub.
- GitHub Actions avec filtres par chemin (lint de `dashboard/` seulement si `dashboard/**` change, etc.).

---

## 11. Démo

- **Mode démo** : `interval_s` = 5 s depuis le dashboard, pour que les courbes bougent devant le jury. Mode production : 60 s.
- **Son** : bouton « Activer les alertes sonores » à cliquer au début (les navigateurs bloquent le son avant une interaction).
- **Historique** : `tools/fake-esp` en mode remplissage génère un mois de données réalistes sur `SX-SIM` (cycle jour/nuit, incidents injectés).
- **Bonus si tout marche** : le simulateur se connecte comme `SX-002` pour montrer un deuxième boîtier en direct.
- **Tests capteurs** : gaz de briquet **non allumé** pour le MQ-2, sèche-cheveux pour le DHT22.
- **Reconstruction après le pentest** : `docker compose up` + reflash de l'ESP en moins de 5 minutes.

---

## 12. Points ouverts

- [ ] Option A (Raspberry Pi 5) ou B (PC portable sous Linux) pour le PC Serveur Local
- [ ] NestJS confirmé, ou FastAPI si l'équipe dev est plus à l'aise en Python
- [ ] Coachs : `POST /api/v1/alerts` peut-il être appelé par le backend plutôt que par l'ESP ?
- [ ] INFRA : serveur NTP local prévu ? (sinon datation à la réception, comme prévu)
- [ ] Coachs : règles du pentest (désauthentification Wi-Fi autorisée ?)
- [ ] Un seuil local de gaz sur l'ESP est-il accepté, vu l'interdiction des seuils statiques côté IA ?
- [ ] CYBER : authentification de l'ESP par certificat (mTLS) dès la v1, ou login/mot de passe d'abord ?
- [ ] Reconnaissance faciale : validée dans le périmètre par l'équipe IA ?
- [ ] Mettre à jour `init.sql` et le contrat d'API partagé sur cette version
