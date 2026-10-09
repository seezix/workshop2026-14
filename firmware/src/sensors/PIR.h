//
// Created by yann5 on 07/10/2026.
//

#ifndef PIO_PIR_H
#define PIO_PIR_H
#include <Arduino.h>


class PIR {
public:
    explicit PIR(uint8_t pin);

    void begin();

    int read();

private:
    uint8_t _pin;
};


#endif //PIO_PIR_H
