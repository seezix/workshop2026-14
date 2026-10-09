//
// Created by yann5 on 06/10/2026.
//

#ifndef PIO_WIFIMANAGER_H
#define PIO_WIFIMANAGER_H

#include <Arduino.h>

class WifiManager {

public:

    WifiManager(const char* ssid, const char* password);

    // Bloque jusqu'à 15 s au démarrage, le temps de la première connexion.
    void begin();
    // Non bloquant : suit l'état du lien et relance la connexion si elle tarde.
    void update();

    bool isConnected();

    String getIP();

private:

    const char* _ssid;
    const char* _password;

    bool _etaitConnecte = false;
    unsigned long _derniereTentative = 0;

    void connect();
};


#endif //PIO_WIFIMANAGER_H
