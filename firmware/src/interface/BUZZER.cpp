//
// Created by yann5 on 07/10/2026.
//

#include "BUZZER.h"

#include <Arduino.h>

// Demi-période d'un bip d'alarme.
static const unsigned long BIP_MS = 250;

BUZZER::BUZZER(uint8_t pin):
    _pin(pin),_mode(ARRET),_debut(0),_duree(0) {
}

void BUZZER::begin() {
    pinMode(_pin, OUTPUT);
    off();
}

void BUZZER::demarrer(Mode mode, unsigned long durationMs) {
    _mode = mode;
    _debut = millis();
    _duree = durationMs;
    digitalWrite(_pin, HIGH);
}

void BUZZER::on(unsigned long durationMs) {
    demarrer(CONTINU, durationMs);
}

void BUZZER::beep(unsigned long durationMs) {
    demarrer(BIP, durationMs);
}

void BUZZER::off() {
    _mode = ARRET;
    digitalWrite(_pin, LOW);
}

void BUZZER::update() {
    if (_mode == ARRET) {
        return;
    }

    unsigned long ecoule = millis() - _debut;

    if (_duree > 0 && ecoule >= _duree) {
        off();
        return;
    }

    bool son = _mode == CONTINU || (ecoule / BIP_MS) % 2 == 0;
    digitalWrite(_pin, son ? HIGH : LOW);
}

bool BUZZER::isOn() const {
    return _mode != ARRET;
}
