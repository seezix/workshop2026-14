//
// Created by yann5 on 06/10/2026.
//

#include "WifiManager.h"

#include <ESP8266WiFi.h>

// Sans reconnexion automatique au bout de ce délai, on relance WiFi.begin().
static const unsigned long RETRY_MS = 30000;


WifiManager::WifiManager(const char* ssid,const char* password)
    : _ssid(ssid),_password(password) {
}


void WifiManager::begin() {

    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);

    connect();
}


void WifiManager::connect() {

    Serial.print("Connexion au WiFi : ");
    Serial.println(_ssid);

    WiFi.begin(_ssid, _password);
    _derniereTentative = millis();

    unsigned long start = millis();

    while (
        WiFi.status() != WL_CONNECTED &&
        millis() - start < 15000
    ) {

        delay(500);

        Serial.print(".");
    }

    Serial.println();

    _etaitConnecte = isConnected();

    if (_etaitConnecte) {

        Serial.println("WiFi connecté");

        Serial.print("IP : ");
        Serial.println(WiFi.localIP());

    } else {

        Serial.println("Échec de connexion WiFi");
    }
}


void WifiManager::update() {

    bool connecte = isConnected();

    if (connecte != _etaitConnecte) {

        _etaitConnecte = connecte;

        if (connecte) {
            Serial.print("WiFi reconnecté, IP : ");
            Serial.println(WiFi.localIP());
        } else {
            Serial.println("WiFi déconnecté");
            _derniereTentative = millis();
        }
    }

    // L'ESP se reconnecte seul ; s'il n'y arrive pas, on relance sans attendre
    // le résultat (le buzzer et la LED continuent de vivre dans la boucle).
    if (!connecte && millis() - _derniereTentative >= RETRY_MS) {

        Serial.println("Nouvelle tentative WiFi");

        WiFi.begin(_ssid, _password);
        _derniereTentative = millis();
    }
}


bool WifiManager::isConnected() {

    return WiFi.status() == WL_CONNECTED;
}


String WifiManager::getIP() {

    if (!isConnected()) {
        return "";
    }

    return WiFi.localIP().toString();
}
