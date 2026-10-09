//
// Created by yann5 on 07/10/2026.
//

#include "OLED.h"

OLED::OLED(
    uint8_t pinScl,
    uint8_t pinSda,
    const int Height,
    const int Width
) : _pinScl(pinScl),_pinSda(pinSda),_height(Height),_width(Width),_ok(false),_ecran(Width, Height, &Wire, -1) {
}


void OLED::begin() {

    Wire.begin(_pinSda, _pinScl);

    _ok = _ecran.begin(SSD1306_SWITCHCAPVCC, 0x3C);

    if (!_ok) {
        Serial.println("OLED BEGIN ECHEC");
        return;
    }

    afficherTexte("OLED OK");

    Serial.println("OLED OK");
}

void OLED::afficherTexte(const char* texte) {

    if (!_ok) {
        return;
    }

    _ecran.clearDisplay();

    _ecran.setTextSize(1);

    _ecran.setTextColor(SSD1306_WHITE);

    _ecran.setCursor(0, 0);

    _ecran.println(texte);

    _ecran.display();
}

void OLED::afficherLignes(const char* l1, const char* l2, const char* l3, const char* l4) {

    if (!_ok) {
        return;
    }

    _ecran.clearDisplay();

    _ecran.setTextSize(1);

    _ecran.setTextColor(SSD1306_WHITE);

    const char* lignes[] = {l1, l2, l3, l4};

    for (int i = 0; i < 4; i++) {
        _ecran.setCursor(0, i * 16);
        _ecran.print(lignes[i]);
    }

    _ecran.display();
}

void OLED::afficherCroix() {

    if (!_ok) {
        return;
    }

    _ecran.clearDisplay();

    _ecran.drawLine(
        20, 10,
        108, 54,
        SSD1306_WHITE
    );

    _ecran.drawLine(
        108, 10,
        20, 54,
        SSD1306_WHITE
    );

    _ecran.display();
}
