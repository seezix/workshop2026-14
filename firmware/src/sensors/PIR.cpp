//
// Created by yann5 on 07/10/2026.
//

#include "PIR.h"

PIR::PIR(uint8_t pin)
    : _pin(pin) {
}

void PIR::begin() {
    pinMode(_pin, INPUT);
}

int PIR::read() {
    return digitalRead(_pin);
}