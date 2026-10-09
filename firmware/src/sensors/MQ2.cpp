//
// Created by yann5 on 06/10/2026.
//

#include "MQ2.h"

MQ2::MQ2(uint8_t pin)
    : _pin(pin), _baseline(0) {
}

void MQ2::begin() {
    // Initialisation du MQ-2
    //MQUnifiedsensor MQ2(String(ESP8266), 1.0, 10, PIN_MQ2, String(2));
}

int MQ2::readRaw() {

    long total = 0;

    // Moyenne courte (20 ms) : la boucle principale ne doit pas attendre.
    for (int i = 0; i < 10; i++) {
        total += analogRead(_pin);
        delay(2);
    }

    float moyenne = total / 10.0;

    return moyenne;
}

float MQ2::getBaseline() {
    return _baseline;
}

void MQ2::calibrate() {
    // Future logique de calibration
}