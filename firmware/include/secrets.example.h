// Modèle des secrets du boîtier : copier en include/secrets.h (ignoré par Git) et remplir.
#ifndef PIO_SECRETS_H
#define PIO_SECRETS_H

#include <Arduino.h>

#define WIFI_SSID "mon-wifi"
#define WIFI_PASS "mot-de-passe-wifi"

// Identifiant du boîtier : doit exister dans la table devices du backend.
#define DEVICE_ID "SX-001"

// Adresse du serveur qui héberge Mosquitto : celle du certificat du broker.
#define MQTT_HOST "192.168.1.10"
// 1 : MQTTS (TLS, certificat CA ci-dessous). 0 : MQTT en clair.
// Broker du docker-compose.yml : MQTTS, port publié 6083.
#define MQTT_USE_TLS 1
#define MQTT_PORT 6083
// L'ACL Mosquitto attend username = identifiant du boîtier.
#define MQTT_USER DEVICE_ID
#define MQTT_PASS "mot-de-passe-mqtt"

// Autorité qui a signé le certificat du broker : contenu de infra/mosquitto/certs/ca.crt.
static const char CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF";

#endif //PIO_SECRETS_H
