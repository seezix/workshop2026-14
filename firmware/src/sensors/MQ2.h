//
// Created by yann5 on 06/10/2026.
//

#ifndef PIO_MQ2_H
#define PIO_MQ2_H

#include <Arduino.h>

class MQ2 {
public:
    explicit MQ2(uint8_t pin);

    void begin();

    int readRaw();

    float getBaseline();
    void calibrate();

private:
    uint8_t _pin;
    float _baseline;
};

#endif
