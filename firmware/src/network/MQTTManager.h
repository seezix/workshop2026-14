//
// Created by yann5 on 06/10/2026.
//

#ifndef PIO_MQTTMANAGER_H
#define PIO_MQTTMANAGER_H

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "../interface/BUZZER.h"
#include "../interface/LED.h"

// Liaison avec le backend (topics sentinel/v1/{device_id}/...) :
//   telemetry, events, status, cmd/ack  →  backend
//   cmd, config                         ←  backend
class MQTTManager {
public:
    MQTTManager(
        const char* server,
        uint16_t port,
        const char* user,
        const char* password,
        const char* clientId,
        BUZZER& buzzer,
        LED& led
        );

    void begin();
    // À appeler à chaque tour de boucle : réception des commandes, reconnexion.
    void update();

    bool isConnected();

    // Résumé périodique (topic telemetry).
    bool publishTelemetry(const char* payload);
    // Détection ou événement technique (topic events). Hors connexion, les 32
    // derniers sont gardés et renvoyés à la reconnexion.
    // type, extraKey et extraValue doivent être des chaînes constantes.
    void publishEvent(const char* type, const char* extraKey = nullptr, const char* extraValue = nullptr);

    // Active MQTTS. Sans certificat, la connexion se fait en clair.
    void setCACert(const char* caCert);

    // Numéro de message, commun à telemetry et events.
    uint32_t nextSeq() { return _seq++; }

    [[nodiscard]] uint16_t intervalS() const { return _intervalS; }
    [[nodiscard]] bool armed() const { return _armed; }

private:
    static const uint8_t EVENT_QUEUE = 32;
    static const uint8_t CMD_MEMORY = 16;
    static const uint8_t CMD_ID_LEN = 32;

    struct Event {
        uint32_t seq;
        uint32_t uptimeMs;
        const char* type;
        const char* extraKey;
        const char* extraValue;
    };

    const char* _server;
    uint16_t _port;
    const char* _user;
    const char* _password;
    const char* _clientId;
    const char* _caCert = nullptr;
    String _tStatus, _tConfig, _tCmd, _tAck, _tTelemetry, _tEvents;
    uint16_t _intervalS = 5;
    bool _armed = true;
    uint32_t _seq = 0;

    BUZZER& _buzzer;
    LED& _led;

    WiFiClient _plainClient;
    WiFiClientSecure _tlsClient;
    PubSubClient _mqttClient;

    bool _tentative = false;
    unsigned long _derniereTentative = 0;
    bool _bootEnvoye = false;

    // Tampon circulaire des événements à envoyer.
    Event _events[EVENT_QUEUE];
    uint8_t _eventHead = 0;
    uint8_t _eventCount = 0;

    // Derniers cmd_id reçus (anti-rejeu).
    char _cmdIds[CMD_MEMORY][CMD_ID_LEN];
    uint8_t _cmdNext = 0;

    void connect();
    void onMessage(char* topic, byte* payload, unsigned int len);
    void onConfig(const byte* payload, unsigned int len);
    void onCommand(const byte* payload, unsigned int len);

    // Exécutent l'action. Renvoient nullptr, ou la raison du refus.
    const char* runBuzzer(JsonObjectConst params);
    const char* runLed(JsonObjectConst params);

    bool dejaRecue(const char* cmdId);
    void ack(const char* cmdId, const char* reason);
    void envoyerEvenements();
};

#endif
