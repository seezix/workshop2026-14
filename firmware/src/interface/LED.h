//
// LED bicolore (rouge / verte), non bloquante.
//

#ifndef PIO_LED_H
#define PIO_LED_H
#include <cstdint>

class LED {
public:
    enum Couleur { ETEINTE, ROUGE, VERTE };

    LED(uint8_t redPin, uint8_t greenPin);

    void begin();
    // À appeler à chaque tour de boucle.
    void update();

    // durationMs = 0 : état durable, jusqu'au prochain ordre.
    // durationMs > 0 : flash temporaire, puis retour à l'état durable
    // (un flash d'avertissement n'efface pas le rouge d'une alarme).
    void set(Couleur couleur, bool blink = false, unsigned long durationMs = 0);
    void off();

private:
    struct Etat {
        Couleur couleur;
        bool blink;
    };

    uint8_t _redPin;
    uint8_t _greenPin;

    Etat _durable;
    Etat _flash;
    bool _flashActif;
    unsigned long _flashDebut;
    unsigned long _flashDuree;

    void appliquer();
};


#endif //PIO_LED_H
