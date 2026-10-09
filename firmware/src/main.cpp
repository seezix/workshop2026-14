#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <ctime>

// WiFi, broker MQTT, certificat : include/secrets.h (modèle : secrets.example.h).
#include "secrets.h"
#include "network/WifiManager.h"
#include "network/MQTTManager.h"
#include "interface/BUZZER.h"
#include "interface/LED.h"
#include "interface/OLED.h"
#include "sensors/MQ2.h"
#include "sensors/DHT22.h"
#include "sensors/PIR.h"

#define PIN_MQ2 A0
#define PIN_DHT D5
#define PIN_BUZZER D6
#define PIN_PIR D7
#define PIN_SCL D3
#define PIN_SDA D2
#define LED_RED D1
#define LED_GREEN D0

// Rythmes de la boucle. Aucun delay() : MQTT, le buzzer et la LED vivent à chaque tour.
static const unsigned long SAMPLE_MS = 2000;        // lecture du DHT22 et du MQ-2
static const unsigned long NTP_TIMEOUT_MS = 15000;  // attente maximale de l'heure au démarrage
static const unsigned long PIR_WARMUP_MS = 60000;   // stabilisation du HC-SR501, détections ignorées
static const unsigned long MOTION_GAP_MS = 2000;    // écart minimal entre deux détections
static const unsigned long REFLEXE_MS = 2000;       // flash rouge local sur une détection
static const uint8_t DHT_ECHECS_PANNE = 5;          // lectures ratées de suite avant SENSOR_FAILURE

OLED ecran(PIN_SCL,PIN_SDA,64,128);
BUZZER buzzer(PIN_BUZZER);
LED led(LED_RED,LED_GREEN);

MQ2 mq2(PIN_MQ2);
DHT22 dht(PIN_DHT);
PIR pir(PIN_PIR);

WifiManager wifi(WIFI_SSID, WIFI_PASS);
MQTTManager mqtt(MQTT_HOST,MQTT_PORT,MQTT_USER,MQTT_PASS,DEVICE_ID,buzzer,led);

// Cumul d'une mesure sur la période du résumé.
struct Stat {
    float somme = 0;
    float mini = 0;
    float maxi = 0;
    float dernier = 0;
    uint16_t n = 0;

    void add(float v) {
        if (n == 0 || v < mini) mini = v;
        if (n == 0 || v > maxi) maxi = v;
        somme += v;
        dernier = v;
        n++;
    }

    void reset() {
        somme = 0;
        n = 0;
    }
};

Stat tempStat, humStat, gasStat;
unsigned int motionCount = 0;

unsigned long lastSample = 0;
unsigned long lastSend = 0;

bool pirActif = false;
unsigned long derniereDetection = 0;

uint8_t dhtEchecs = 0;
bool dhtEnPanne = false;

bool alarmeAffichee = false;

static double arrondi(float v, int decimales) {
    double facteur = decimales == 1 ? 10.0 : 1.0;
    return round(v * facteur) / facteur;
}

// Remplit {avg,min,max,last}, ou null si toutes les lectures de la période ont échoué.
void setStat(JsonDocument& doc, const char* key, const Stat& stat, int decimales) {
    if (stat.n == 0) {
        doc[key] = nullptr;
        return;
    }
    JsonObject o = doc[key].to<JsonObject>();
    o["avg"]  = arrondi(stat.somme / stat.n, decimales);
    o["min"]  = arrondi(stat.mini, decimales);
    o["max"]  = arrondi(stat.maxi, decimales);
    o["last"] = arrondi(stat.dernier, decimales);
}

#if MQTT_USE_TLS
// Sans date plausible, le certificat du broker ne peut pas être validé.
void synchroniserHeure() {
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    Serial.print("Synchro heure");

    unsigned long start = millis();

    while (time(nullptr) < 8 * 3600 * 2 && millis() - start < NTP_TIMEOUT_MS) {
        delay(500);
        Serial.print(".");
    }

    // En cas d'échec, la synchro continue en tâche de fond et MQTT réessaie.
    Serial.println(time(nullptr) < 8 * 3600 * 2 ? " ÉCHEC" : " OK");
}
#endif

void afficherEtat() {
    char l1[22], l2[22], l3[22], l4[22];

    snprintf(l1, sizeof(l1), "%s %s", DEVICE_ID, mqtt.armed() ? "ARME" : "DESARME");
    snprintf(l2, sizeof(l2), "WiFi %s MQTT %s",
             wifi.isConnected() ? "OK" : "--", mqtt.isConnected() ? "OK" : "--");

    if (isnan(dht.getTemperature())) {
        snprintf(l3, sizeof(l3), "T --  H --");
    } else {
        snprintf(l3, sizeof(l3), "T %.1fC  H %.0f%%", dht.getTemperature(), dht.getHumidity());
    }

    snprintf(l4, sizeof(l4), "Gaz %d", (int) gasStat.dernier);

    ecran.afficherLignes(l1, l2, l3, l4);
}

// À chaque tour : un front montant du PIR part tout de suite sur events.
void surveillerPir(unsigned long now) {
    bool actif = pir.read() == HIGH;
    bool front = actif && !pirActif;

    pirActif = actif;

    if (!front || now < PIR_WARMUP_MS) return;
    if (now - derniereDetection < MOTION_GAP_MS) return;

    derniereDetection = now;
    motionCount++;

    // Envoyé même désarmé : le backend garde la trace sans créer d'alerte.
    mqtt.publishEvent("MOTION_DETECTED");

    // Réflexe local, sans attendre le serveur.
    if (mqtt.armed()) {
        led.set(LED::ROUGE, false, REFLEXE_MS);
    }
}

// Toutes les 2 s : capteurs lents, cumulés dans le résumé.
void lireCapteurs() {
    gasStat.add(mq2.readRaw());

    if (dht.update() && !isnan(dht.getTemperature()) && !isnan(dht.getHumidity())) {
        tempStat.add(dht.getTemperature());
        humStat.add(dht.getHumidity());
        dhtEchecs = 0;
        dhtEnPanne = false;
    } else {
        if (dhtEchecs < DHT_ECHECS_PANNE) dhtEchecs++;

        if (dhtEchecs >= DHT_ECHECS_PANNE && !dhtEnPanne) {
            dhtEnPanne = true;
            mqtt.publishEvent("SENSOR_FAILURE", "sensor", "dht22");
        }
    }
}

// Toutes les interval_s secondes (réglé par le backend sur le topic config).
void envoyerResume() {
    JsonDocument doc;

    doc["seq"]        = mqtt.nextSeq();
    doc["uptime_ms"]  = millis();
    doc["interval_s"] = mqtt.intervalS();
    // Lectures valides : les lectures DHT22 ratées le font baisser. DHT22 muet,
    // on compte celles du gaz (le backend pondère ses moyennes par samples).
    doc["samples"]    = tempStat.n > 0 ? tempStat.n : gasStat.n;

    setStat(doc, "temperature_c", tempStat, 1);
    setStat(doc, "humidity_pct",  humStat, 1);
    setStat(doc, "gas_raw",       gasStat, 0);

    // Le résumé ne répète pas les détections, il les compte.
    doc["motion_count"] = motionCount;
    // Pas de capteur IR sur ce boîtier.
    doc["ir_count"]     = 0;

    int rssi = WiFi.RSSI();
    if (rssi < 0 && rssi >= -150) doc["rssi_dbm"] = rssi;

    char jsonBuffer[448];
    serializeJson(doc, jsonBuffer);

    if (!mqtt.publishTelemetry(jsonBuffer)) {
        Serial.println("Résumé non envoyé (MQTT déconnecté)");
    }

    tempStat.reset();
    humStat.reset();
    gasStat.reset();
    motionCount = 0;
}

void setup() {

    Serial.begin(115200);

    Serial.println();
    Serial.println("========================");
    Serial.println("        BOOT ESP");
    Serial.println("========================");

    buzzer.begin();
    led.begin();
    ecran.begin();

    mq2.begin();
    dht.begin();
    pir.begin();

    ecran.afficherTexte("Connexion WiFi...");
    wifi.begin();

#if MQTT_USE_TLS
    synchroniserHeure();
    mqtt.setCACert(CA_CERT);
#endif

    ecran.afficherTexte("Connexion MQTT...");
    mqtt.begin();
}

void loop() {

    wifi.update();
    // Reçoit les commandes et la config du backend, et les applique.
    mqtt.update();
    buzzer.update();
    led.update();

    unsigned long now = millis();

    surveillerPir(now);

    // L'alarme prend l'écran tant que le buzzer sonne.
    bool alarme = buzzer.isOn();

    if (alarme != alarmeAffichee) {
        alarmeAffichee = alarme;
        if (alarme) {
            ecran.afficherCroix();
        } else {
            afficherEtat();
        }
    }

    if (now - lastSample >= SAMPLE_MS) {
        lastSample = now;
        lireCapteurs();
        if (!alarme) afficherEtat();
    }

    if (now - lastSend >= mqtt.intervalS() * 1000UL) {
        lastSend = now;
        envoyerResume();
    }
}
