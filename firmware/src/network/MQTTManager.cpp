//
// Created by yann5 on 06/10/2026.
//

#include "MQTTManager.h"
#include <ctime>

#define TOPIC_PREFIX "sentinel/v1"
#define FW_VERSION "1.1.0"

// Délai entre deux tentatives de connexion : un handshake TLS raté bloque
// plusieurs secondes, on ne le relance pas à chaque tour de boucle.
static const unsigned long RECONNECT_MS = 5000;
// Limites appliquées par le boîtier, même si le backend en envoie d'autres.
static const long DUREE_MAX_MS = 10000;
static const unsigned long BEEP_DEFAUT_MS = 1000;
static const int INTERVAL_MIN_S = 2;
static const int INTERVAL_MAX_S = 300;

MQTTManager::MQTTManager(
    const char* server,
    uint16_t port,
    const char* user,
    const char* password,
    const char* clientId,
    BUZZER& buzzer,
    LED& led
)
    : _server(server),
      _port(port),
      _user(user),
      _password(password),
      _clientId(clientId),
      _buzzer(buzzer),
      _led(led),
      _mqttClient(_plainClient) {
    memset(_cmdIds, 0, sizeof(_cmdIds));
}

void MQTTManager::setCACert(const char* caCert) {
    _caCert = caCert;
}

void MQTTManager::begin() {

    if (_caCert != nullptr) {
        _tlsClient.setTrustAnchors(new BearSSL::X509List(_caCert));
        _mqttClient.setClient(_tlsClient);
    } else {
        Serial.println("[MQTT] Pas de certificat CA : connexion en clair");
    }

    String base = String(TOPIC_PREFIX) + "/" + _clientId;
    _tStatus    = base + "/status";
    _tConfig    = base + "/config";
    _tCmd       = base + "/cmd";
    _tAck       = base + "/cmd/ack";
    _tTelemetry = base + "/telemetry";
    _tEvents    = base + "/events";

    _mqttClient.setServer(_server, _port);

    _mqttClient.setCallback(
        [this](char* topic, byte* payload, unsigned int len) {
            this->onMessage(topic, payload, len);
        }
    );

    // Le résumé dépasse la limite par défaut de PubSubClient (256 octets).
    _mqttClient.setBufferSize(512);

    connect();
}

void MQTTManager::onMessage(char* topic, byte* payload, unsigned int len) {
    Serial.printf("MQTT reçu [%s] (%u o)\n", topic, len);

    if (_tConfig == topic) { onConfig(payload, len); return; }

    if (_tCmd == topic) { onCommand(payload, len); return; }
}

void MQTTManager::onConfig(const byte* payload, unsigned int len) {
    JsonDocument doc;
    if (deserializeJson(doc, (const char*)payload, len)) return;

    if (doc["interval_s"].is<int>()) {
        int interval = doc["interval_s"];
        if (interval >= INTERVAL_MIN_S && interval <= INTERVAL_MAX_S) {
            _intervalS = interval;
        } else {
            Serial.printf("Config : interval_s=%d ignoré (%d à %d s)\n",
                          interval, INTERVAL_MIN_S, INTERVAL_MAX_S);
        }
    }
    if (doc["armed"].is<bool>()) _armed = doc["armed"];

    Serial.printf("Config : interval=%us armed=%d\n", _intervalS, _armed);
}

// duration_ms est facultatif : 0 s'il est absent, -1 s'il est invalide.
static long lireDuree(JsonVariantConst valeur) {
    if (valeur.isNull()) return 0;
    if (!valeur.is<long>()) return -1;

    long duree = valeur.as<long>();

    return (duree >= 1 && duree <= DUREE_MAX_MS) ? duree : -1;
}

// { "cmd_id": "c-8f2a91", "action": "BUZZER", "params": { "mode": "beep", "duration_ms": 3000 } }
void MQTTManager::onCommand(const byte* payload, unsigned int len) {
    // Le document copie les chaînes : il reste valable quand l'accusé réutilise
    // le tampon de réception de PubSubClient.
    JsonDocument doc;
    if (deserializeJson(doc, (const char*)payload, len)) {
        Serial.println("Commande ignorée : JSON invalide");
        return;
    }

    const char* cmdId = doc["cmd_id"] | "";
    // Sans cmd_id, aucun accusé possible.
    if (cmdId[0] == '\0') {
        Serial.println("Commande ignorée : cmd_id absent");
        return;
    }
    if (strlen(cmdId) >= CMD_ID_LEN) { ack(cmdId, "invalid_params"); return; }
    if (dejaRecue(cmdId))            { ack(cmdId, "duplicate"); return; }

    strlcpy(_cmdIds[_cmdNext], cmdId, CMD_ID_LEN);
    _cmdNext = (_cmdNext + 1) % CMD_MEMORY;

    const char* action = doc["action"] | "";
    JsonObjectConst params = doc["params"];
    const char* reason;

    if (strcmp(action, "BUZZER") == 0) {
        reason = runBuzzer(params);
    } else if (strcmp(action, "LED") == 0) {
        reason = runLed(params);
    } else {
        reason = "unknown_action";
    }

    ack(cmdId, reason);
}

const char* MQTTManager::runBuzzer(JsonObjectConst params) {
    const char* mode = params["mode"] | "";
    long duree = lireDuree(params["duration_ms"]);

    if (duree < 0) return "invalid_params";

    if (strcmp(mode, "off") == 0) {
        _buzzer.off();
    } else if (strcmp(mode, "on") == 0) {
        _buzzer.on(duree);
    } else if (strcmp(mode, "beep") == 0) {
        _buzzer.beep(duree > 0 ? duree : BEEP_DEFAUT_MS);
    } else {
        return "invalid_params";
    }

    Serial.printf("Commande BUZZER %s %ld ms\n", mode, duree);
    return nullptr;
}

const char* MQTTManager::runLed(JsonObjectConst params) {
    const char* color = params["color"] | "";
    JsonVariantConst blink = params["blink"];
    long duree = lireDuree(params["duration_ms"]);

    if (duree < 0) return "invalid_params";
    if (!blink.isNull() && !blink.is<bool>()) return "invalid_params";

    if (strcmp(color, "off") == 0) {
        _led.off();
    } else if (strcmp(color, "red") == 0) {
        _led.set(LED::ROUGE, blink | false, duree);
    } else if (strcmp(color, "green") == 0) {
        _led.set(LED::VERTE, blink | false, duree);
    } else {
        return "invalid_params";
    }

    Serial.printf("Commande LED %s blink=%d %ld ms\n", color, blink | false, duree);
    return nullptr;
}

bool MQTTManager::dejaRecue(const char* cmdId) {
    for (uint8_t i = 0; i < CMD_MEMORY; i++) {
        if (strcmp(_cmdIds[i], cmdId) == 0) return true;
    }
    return false;
}

// { "cmd_id": "c-8f2a91", "status": "done" } ou "rejected" avec "reason".
void MQTTManager::ack(const char* cmdId, const char* reason) {
    JsonDocument doc;

    doc["cmd_id"] = cmdId;
    doc["status"] = reason == nullptr ? "done" : "rejected";
    if (reason != nullptr) doc["reason"] = reason;

    char jsonBuffer[192];
    serializeJson(doc, jsonBuffer);

    _mqttClient.publish(_tAck.c_str(), jsonBuffer);

    Serial.printf("Accusé %s\n", jsonBuffer);
}

void MQTTManager::connect() {

    if (!WiFi.isConnected()) {
        return;
    }

    _tentative = true;
    _derniereTentative = millis();

    Serial.print("Connexion MQTT... ");

    if (_mqttClient.connect(_clientId, _user, _password,
                            _tStatus.c_str(), 1, true,
                            R"({"state":"offline"})")) {
        Serial.println("OK");

        char status[96];
        snprintf(status, sizeof(status),
                 R"({"state":"online","fw":"%s","ip":"%s"})",
                 FW_VERSION, WiFi.localIP().toString().c_str());
        _mqttClient.publish(_tStatus.c_str(), status, true);

        // config est retained : le broker la renvoie dès l'abonnement.
        _mqttClient.subscribe(_tConfig.c_str(), 1);
        _mqttClient.subscribe(_tCmd.c_str(), 1);

        if (!_bootEnvoye) {
            _bootEnvoye = true;
            publishEvent("BOOT");
        }
    } else {
        Serial.print("Échec MQTT, code = ");
        Serial.println(_mqttClient.state());

        if (_caCert != nullptr) {
            char err[128];
            int e = _tlsClient.getLastSSLError(err, sizeof(err));
            if (e != 0) {
                Serial.print("Erreur TLS : ");
                Serial.println(err);
            }
            if (time(nullptr) < 8 * 3600 * 2) {
                Serial.println("Heure non synchronisée : le certificat ne peut pas être validé");
            }
        }
    }
}

void MQTTManager::update() {

    if (!WiFi.isConnected()) {
        return;
    }

    if (_mqttClient.connected()) {
        _mqttClient.loop();
        envoyerEvenements();
        return;
    }

    if (!_tentative || millis() - _derniereTentative >= RECONNECT_MS) {
        connect();
    }
}

bool MQTTManager::isConnected() {
    return _mqttClient.connected();
}

bool MQTTManager::publishTelemetry(const char* payload) {
    if (!isConnected()) {
        return false;
    }

    return _mqttClient.publish(_tTelemetry.c_str(), payload);
}

void MQTTManager::publishEvent(const char* type, const char* extraKey, const char* extraValue) {
    // Tampon plein : le plus ancien est abandonné.
    if (_eventCount == EVENT_QUEUE) {
        _eventHead = (_eventHead + 1) % EVENT_QUEUE;
        _eventCount--;
    }

    Event& event = _events[(_eventHead + _eventCount) % EVENT_QUEUE];
    event.seq = nextSeq();
    event.uptimeMs = millis();
    event.type = type;
    event.extraKey = extraKey;
    event.extraValue = extraValue;
    _eventCount++;

    Serial.printf("Événement %s\n", type);

    envoyerEvenements();
}

// { "seq": 412, "uptime_ms": 3605120, "type": "MOTION_DETECTED" }
void MQTTManager::envoyerEvenements() {
    while (_eventCount > 0 && isConnected()) {
        const Event& event = _events[_eventHead];

        JsonDocument doc;
        doc["seq"] = event.seq;
        doc["uptime_ms"] = event.uptimeMs;
        doc["type"] = event.type;
        if (event.extraKey != nullptr) doc[event.extraKey] = event.extraValue;

        char jsonBuffer[160];
        serializeJson(doc, jsonBuffer);

        if (!_mqttClient.publish(_tEvents.c_str(), jsonBuffer)) {
            return;
        }

        _eventHead = (_eventHead + 1) % EVENT_QUEUE;
        _eventCount--;
    }
}
