//
// Created by yann5 on 06/10/2026.
//

#ifndef PIO_DHT_H
#define PIO_DHT_H
#include <string>

#include "DHTesp.h"


class DHT22 {
public:
    explicit DHT22(uint8_t pin);

    void begin();
    bool update();

    float getTemperature() const;
    float getHumidity() const;

private:
    uint8_t _pin;
    DHTesp _sensor;

    float _temperature;
    float _humidity;
};

#endif //PIO_DHT_H
