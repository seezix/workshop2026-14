//
// Created by yann5 on 06/10/2026.
//
#include "DHT22.h"

DHT22::DHT22(uint8_t pin):
    _pin(pin),_sensor(),_temperature(NAN),_humidity(NAN) {
}

void DHT22::begin() {
    _sensor.setup(_pin, DHTesp::DHT22);
}

bool DHT22::update() {
    TempAndHumidity data = _sensor.getTempAndHumidity();

    if (_sensor.getStatus() != DHTesp::ERROR_NONE) {
        Serial.print("Erreur DHT22 : ");
        Serial.println(_sensor.getStatusString());
        return false;
    }

    _temperature = data.temperature;
    _humidity = data.humidity;

    return true;
}

float DHT22::getTemperature() const {

    return _temperature;
}

float DHT22::getHumidity() const {

    return _humidity;
}