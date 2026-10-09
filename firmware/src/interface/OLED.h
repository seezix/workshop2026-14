//
// Created by yann5 on 07/10/2026.
//

#ifndef PIO_OLED_H
#define PIO_OLED_H

#include <Adafruit_SSD1306.h>

class OLED {
public:
    explicit OLED(
        uint8_t pinScl,
        uint8_t pinSda,
        int Height,
        int Width
    );

    void begin();

    void afficherTexte(const char* texte);
    // Écran d'état : une ligne par argument.
    void afficherLignes(const char* l1, const char* l2, const char* l3, const char* l4);
    void afficherCroix();
private:
    uint8_t _pinScl;
    uint8_t _pinSda;
    const int _height;
    const int _width;
    // Faux tant que begin() n'a pas réussi : sans écran, les affichages sont ignorés.
    bool _ok;

    Adafruit_SSD1306 _ecran;
};


#endif //PIO_OLED_H
