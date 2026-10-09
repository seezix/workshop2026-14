//
// Created by yann5 on 07/10/2026.
//

#ifndef PIO_BUZZER_H
#define PIO_BUZZER_H
#include <cstdint>

// Buzzer non bloquant : on()/beep() lancent le son, update() le fait vivre.
class BUZZER {
public:
    explicit BUZZER(uint8_t pin);

    void begin();
    // À appeler à chaque tour de boucle.
    void update();

    // Son continu. durationMs = 0 : jusqu'à off().
    void on(unsigned long durationMs = 0);
    // Bips d'alarme pendant durationMs.
    void beep(unsigned long durationMs);
    void off();

    [[nodiscard]] bool isOn() const;

private:
    enum Mode { ARRET, CONTINU, BIP };

    uint8_t _pin;
    Mode _mode;
    unsigned long _debut;
    unsigned long _duree;

    void demarrer(Mode mode, unsigned long durationMs);
};


#endif //PIO_BUZZER_H
