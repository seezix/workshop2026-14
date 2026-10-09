# Firmware Sentinel-X (ESP8266)

Firmware du boîtier `SX-001` : C++ Arduino sous PlatformIO, pour un ESP8266 (ESP-12E / NodeMCU). Il parle au backend par MQTT (contrat : [`docs/GUIDELINES.md` §5](../docs/GUIDELINES.md)).

## Démarrage rapide

Compter 10 minutes. Les commandes partent de la racine du dépôt, sauf mention contraire.

### 1. Serveur : mettre à jour et arrêter le faux boîtier

Le signal du boîtier sur alerte (buzzer, LED) est décidé par le backend : il faut son image à jour. Le broker n'accepte que MQTTS : `server.key` et `ca.crt` doivent être dans `infra/mosquitto/certs/`, sinon la commande s'arrête (voir [Chiffrement](#chiffrement-mqtts)).

```bash
docker compose up -d --build
```

Le faux boîtier se fait passer pour `SX-001` : **il ne doit jamais tourner en même temps que le vrai ESP**.

```bash
docker compose --profile sim stop fake-esp
```

Noter l'IP du serveur sur le réseau Wi-Fi du boîtier (`ipconfig`, ligne « Adresse IPv4 »). Sous Windows, le pare-feu doit laisser entrer le port du broker (6083).

### 2. Secrets du boîtier

```bash
cp firmware/include/secrets.example.h firmware/include/secrets.h
```

`secrets.h` est ignoré par Git. À remplir :

| Constante | Valeur |
|---|---|
| `WIFI_SSID`, `WIFI_PASS` | Réseau Wi-Fi **2,4 GHz** (l'ESP8266 ne voit pas le 5 GHz) |
| `DEVICE_ID` | `SX-001` (doit exister dans la table `devices`, créé par le seed) |
| `MQTT_HOST` | IP du serveur, telle qu'elle figure dans le certificat du broker |
| `MQTT_USE_TLS`, `MQTT_PORT` | `1` et `6083` (port publié par le `docker-compose.yml`, 8883 dans le conteneur) |
| `MQTT_USER`, `MQTT_PASS` | Compte du broker (ignorés tant que le broker est sans authentification) |
| `CA_CERT` | Le contenu de `infra/mosquitto/certs/ca.crt`, entre `R"EOF(` et `)EOF"` |

### 3. Flasher

PlatformIO en ligne de commande (ou l'extension PlatformIO de VS Code / CLion, boutons Upload et Monitor) :

```bash
pip install platformio
```

Brancher l'ESP en USB, puis depuis `firmware/` :

```bash
pio run -t upload
```

```bash
pio device monitor
```

Le port série est fixé à `COM3` dans `platformio.ini`. Autre port (voir le Gestionnaire de périphériques) : `pio run -t upload --upload-port COM5` et `pio device monitor -p COM5`. Aucun port visible : installer le pilote USB de la carte (CH340 ou CP2102).

### 4. Vérifier

Dans le moniteur série (115200 bauds), un démarrage réussi donne :

```
WiFi connecté
IP : 192.168.1.50
Synchro heure.. OK
Connexion MQTT... OK
Événement BOOT
MQTT reçu [sentinel/v1/SX-001/config] (30 o)
Config : interval=60s armed=1
```

Sur l'écran OLED : `WiFi OK MQTT OK`. Dans le dashboard (`http://<IP du serveur>:6080`), le boîtier passe « en ligne » et les mesures arrivent.

### 5. Tester les réactions

| Test | Comment | Résultat attendu |
|---|---|---|
| Commande manuelle | Dashboard : « Tester l'alarme (3 s) », « LED rouge », « LED verte », « Couper le buzzer » | Le boîtier réagit tout de suite, la commande passe à « Exécutée » |
| Alerte `warning` | Passer devant le PIR (boîtier armé, plus de 60 s après le démarrage) | LED rouge 2 s, alerte « Mouvement détecté » |
| Alerte `critical` | Commande ci-dessous (simule un sabotage) | Bips 10 s + LED rouge clignotante |
| Fin d'alarme | Dashboard, page du boîtier : LED « Éteinte », puis « Envoyer au boîtier » | La LED s'éteint |

Simuler une alerte critique, en PowerShell :

```powershell
docker compose exec mosquitto mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -t sentinel/v1/SX-001/events -m '{\"type\":\"TAMPER\"}'
```

En bash (Git Bash, Linux) :

```bash
docker compose exec mosquitto mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -t sentinel/v1/SX-001/events -m '{"type":"TAMPER"}'
```

Une même alerte répétée dans les 10 s est un doublon : le boîtier ne re-signale pas.

## Chiffrement (MQTTS)

Le broker du `docker-compose.yml` n'accepte que MQTTS : TLS 1.2 minimum, port publié `6083` (8883 dans le conteneur), aucun port en clair. L'API et le faux boîtier s'y connectent en `mqtts://` et vérifient son certificat (`MQTT_URL`, `MQTT_CA_FILE`, déjà réglés dans le `docker-compose.yml`). Le boîtier fait de même avec `CA_CERT`.

Seul le broker de développement (`docker-compose.dev.yml`) reste en clair : il n'écoute que sur `127.0.0.1`, l'ESP ne peut pas le joindre.

### 1. Certificats

Trois fichiers dans `infra/mosquitto/certs/` : `server.crt`, `server.key` (jamais commitée) et `ca.crt`. Sans l'un d'eux, `docker compose up` s'arrête.

Le certificat du broker doit porter **l'adresse exacte mise dans `MQTT_HOST`**. Le firmware (BearSSL) ne compare ce nom qu'aux entrées `DNS` du certificat, jamais aux entrées `IP` : l'IP du serveur doit donc y figurer **deux fois**, en `IP:` pour l'API et les outils, en `DNS:` pour l'ESP.

Depuis `infra/mosquitto/certs/`, avec l'IP du serveur sur le Wi-Fi du boîtier :

```bash
export MSYS_NO_PATHCONV=1   # Git Bash sous Windows seulement
IP=192.168.137.158

# Autorité (une seule fois). ca.key ne va ni dans Git ni sur le serveur.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout ca.key -out ca.crt -subj "/CN=Sentinel-X CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# Certificat du broker, à refaire si l'IP du serveur change.
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=mosquitto"
printf 'subjectAltName=DNS:localhost,DNS:mosquitto,DNS:host.docker.internal,IP:127.0.0.1,IP:%s,DNS:%s\nextendedKeyUsage=serverAuth\n' "$IP" "$IP" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -extfile san.ext -out server.crt

openssl verify -CAfile ca.crt server.crt        # doit répondre OK
```

`localhost`, `mosquitto` et `host.docker.internal` servent au healthcheck, à l'API et au faux boîtier. Une autorité existe déjà ? Sauter le premier bloc et signer avec elle.

### 2. Serveur

```bash
docker compose up -d --build
openssl s_client -connect <IP du serveur>:6083 -CAfile infra/mosquitto/certs/ca.crt -verify_hostname <IP du serveur>
```

La dernière ligne utile doit être `Verify return code: 0 (ok)`.

### 3. Boîtier

Dans `firmware/include/secrets.h`, puis reflasher :

| Constante | Valeur |
|---|---|
| `MQTT_USE_TLS` | `1` |
| `MQTT_PORT` | `6083` (le port publié, pas 8883) |
| `MQTT_HOST` | L'IP mise dans le certificat, à l'identique |
| `CA_CERT` | Le contenu de `ca.crt`, entre `R"EOF(` et `)EOF"` |

Le boîtier a besoin de l'heure pour valider les dates du certificat : le Wi-Fi doit donner accès à internet (NTP), au moins au démarrage.

### Pièges connus

- **Autorité différente** : le `server.crt` commité est signé par « Sentinel-X CA ». Un `secrets.h` repris de l'ancien firmware contient une autre autorité (« Sentinel-X Local CA ») : le boîtier refuse alors le broker. `CA_CERT` doit être l'autorité qui a signé le certificat réellement servi.
- **IP en `DNS:` absente** : le `server.crt` commité ne porte `192.168.137.158` qu'en entrée `IP:`. L'API et le faux boîtier l'acceptent, pas l'ESP (`Erreur TLS`, nom du serveur introuvable) : le régénérer comme ci-dessus, avec la même autorité ou une nouvelle.
- **IP du serveur qui change** (autre réseau, bail DHCP) : nouveau certificat et nouveau `MQTT_HOST`.

### Reste à faire : authentification

Chiffré ne veut pas dire authentifié : le broker garde `allow_anonymous true`. Tout appareil du réseau peut encore publier une commande à la place du backend.

Passer `allow_anonymous` à `false` ne suffit pas : seul, il coupe tous les clients, healthcheck compris, donc l'API ne démarre plus. Il faut en même temps :

| Où | Quoi |
|---|---|
| `infra/mosquitto/` | Un fichier de comptes (`mosquitto_passwd`) : `backend`, un compte par boîtier nommé comme son `DEVICE_ID` (`SX-001`), un compte pour le healthcheck. Jamais commité |
| `infra/mosquitto/` | L'ACL de [`GUIDELINES.md` §5.2](../docs/GUIDELINES.md) : sans elle, le compte d'un boîtier peut écrire sur `cmd` |
| `mosquitto.conf` | `allow_anonymous false`, `password_file`, `acl_file` |
| `docker-compose.yml`, service `mosquitto` | Monter les deux fichiers ; donner un compte au healthcheck (`-u`, `-P`) |
| `docker-compose.yml`, service `backend` | `MQTT_PASSWORD` (`backend` est déjà la valeur par défaut de `MQTT_USERNAME`) |
| `docker-compose.yml`, service `fake-esp` | `FAKE_ESP_PASSWORD` (il se connecte déjà sous le nom du boîtier) |
| `.env`, `.env.example` | Les mots de passe ci-dessus |
| `firmware/include/secrets.h` | `MQTT_USER` égal à `DEVICE_ID`, `MQTT_PASS` du compte |

## Réactions du boîtier

| Déclencheur | Buzzer | LED |
|---|---|---|
| Alerte `critical` (toute source) | Bips pendant 10 s | Rouge clignotante, jusqu'à un ordre de l'opérateur |
| Alerte `warning` | | Rouge 2 s |
| Alerte `info` | | Verte 2 s |
| Commande de l'opérateur | `on`, `off`, `beep` + durée (10 s max) | `red`, `green`, `off`, clignotante ou non |
| Mouvement PIR, boîtier armé | | Rouge 2 s, sans attendre le serveur |

Un flash (2 s) n'efface pas l'état durable : après un avertissement, la LED revient au rouge d'une alarme en cours. Au repos, la LED est éteinte. Pendant que le buzzer sonne, l'écran affiche une croix.

Le boîtier désarmé envoie toujours ses détections, mais le backend n'en fait pas d'alerte : pas de signal. Gaz, sabotage, pannes et anomalies passent toujours.

## Câblage

| Composant | Broche |
|---|---|
| MQ-2 (gaz, sortie analogique) | `A0` |
| DHT22 (température, humidité) | `D5` |
| Buzzer actif | `D6` |
| PIR HC-SR501 | `D7` |
| OLED SSD1306 I2C (adresse `0x3C`) | SDA `D2`, SCL `D3` |
| LED rouge | `D1` |
| LED verte | `D0` |

Pas de capteur IR ni de capteur à effet Hall sur ce boîtier : `ir_count` vaut 0 et `magnetic_raw` n'est pas envoyé.

## Ce que le boîtier envoie

| Topic | Quand |
|---|---|
| `status` | `online` à la connexion (avec version et IP), `offline` par le Last Will |
| `telemetry` | Toutes les `interval_s` secondes (réglé par le backend, 2 à 300 s) : résumé des lectures faites toutes les 2 s |
| `events` | Tout de suite : `BOOT`, `MOTION_DETECTED`, `SENSOR_FAILURE` (DHT22 muet 10 s). Hors connexion, les 32 derniers sont gardés et renvoyés |
| `cmd/ack` | `done` ou `rejected` (`unknown_action`, `invalid_params`, `duplicate`) pour chaque commande |

## Dépannage

| Symptôme (moniteur série ou dashboard) | Cause probable |
|---|---|
| `Échec de connexion WiFi` | SSID ou mot de passe faux, réseau en 5 GHz, boîtier trop loin |
| `Échec MQTT, code = -2` | Broker injoignable (`MQTT_HOST` ou `MQTT_PORT` faux, pare-feu du serveur, conteneur `mosquitto` arrêté) ou handshake TLS refusé (ligne `Erreur TLS` juste après) |
| `Échec MQTT, code = 4` ou `5` | Compte ou mot de passe MQTT refusé |
| `Erreur TLS : ...` | Certificat : `CA_CERT` n'est pas l'autorité qui a signé celui du broker, ou ce dernier ne porte pas `MQTT_HOST` en entrée `DNS:` (voir [Pièges connus](#pièges-connus)) |
| `Heure non synchronisée` | Pas d'accès NTP (internet) : le certificat ne peut pas être validé |
| Connecté, mais boîtier « hors ligne » dans le dashboard | Journal du backend : `Boîtier inconnu ... ignoré` → `DEVICE_ID` absent de la table `devices` |
| Mesures en double ou incohérentes, état qui change sans raison | Le faux boîtier tourne en même temps (étape 1) |
| Commande « Sans réponse » | Le boîtier n'a pas reçu la commande : MQTT déconnecté à ce moment-là |
| Commande refusée, `409 DEVICE_OFFLINE` | Le backend voit le boîtier hors ligne |
| Aucune détection de mouvement | Normal pendant les 60 premières secondes (stabilisation du PIR) |
| LED rouge qui flashe sans arrêt | Alertes `warning` en série : voir leur source dans le dashboard. Source `ml` : le MQ-2 réel ne lit pas forcément les valeurs du jeu de référence du service de prévision (repos vers 150), surtout à froid |
| Écran noir, `OLED BEGIN ECHEC` | Câblage I2C ou adresse différente de `0x3C` ; le reste du firmware fonctionne sans écran |

Journal du backend : `docker compose logs -f backend` (une ligne `c-... BUZZER → SX-001 (rule:alert-critical)` par commande envoyée).

## Organisation du code

```
include/secrets.example.h   modèle des secrets (secrets.h est ignoré par Git)
src/main.cpp                boucle non bloquante : PIR, capteurs toutes les 2 s, résumé
src/network/MQTTManager     connexion, config, commandes et accusés, tampon d'événements
src/network/WifiManager     connexion Wi-Fi et reconnexion
src/interface/              BUZZER, LED (durable ou flash), OLED
src/sensors/                DHT22, MQ2, PIR
```

Règle de la boucle : jamais de `delay()`. `mqtt.update()`, `buzzer.update()` et `led.update()` passent à chaque tour ; un blocage retarde la réception des commandes.
