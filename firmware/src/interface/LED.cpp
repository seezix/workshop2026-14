//
// LED bicolore (rouge / verte), non bloquante.
//

#include "LED.h"

#include <Arduino.h>

// Demi-période du clignotement.
static const unsigned long BLINK_MS = 250;

LED::LED(uint8_t redPin, uint8_t greenPin):
    _redPin(redPin),_greenPin(greenPin),
    _durable{ETEINTE, false},_flash{ETEINTE, false},
    _flashActif(false),_flashDebut(0),_flashDuree(0) {
}

void LED::begin() {
    pinMode(_redPin, OUTPUT);
    pinMode(_greenPin, OUTPUT);
    off();
}

void LED::set(Couleur couleur, bool blink, unsigned long durationMs) {
    if (durationMs > 0) {
        _flash = {couleur, blink};
        _flashActif = true;
        _flashDebut = millis();
        _flashDuree = durationMs;
    } else {
        _durable = {couleur, blink};
        _flashActif = false;
    }
    appliquer();
}

void LED::off() {
    _durable = {ETEINTE, false};
    _flashActif = false;
    appliquer();
}

void LED::update() {
    if (_flashActif && millis() - _flashDebut >= _flashDuree) {
        _flashActif = false;
    }
    appliquer();
}

void LED::appliquer() {
    const Etat& etat = _flashActif ? _flash : _durable;

    bool allumee = etat.couleur != ETEINTE &&
                   (!etat.blink || (millis() / BLINK_MS) % 2 == 0);

    digitalWrite(_redPin, allumee && etat.couleur == ROUGE ? HIGH : LOW);
    digitalWrite(_greenPin, allumee && etat.couleur == VERTE ? HIGH : LOW);
}
