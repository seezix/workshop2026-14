import { parseReferenceLine } from './reference-data.js';

describe('parseReferenceLine', () => {
  it('convertit une ligne du CSV vers les colonnes de la table', () => {
    expect(
      parseReferenceLine('19.6,65.7,1.0,150,0,2026-06-01 00:00:00,Normal'),
    ).toEqual({
      time: '2026-06-01 00:00:00+00',
      temp: 19.6,
      hum: 65.7,
      hallState: 1,
      gas: 150,
      clusterId: 0,
      label: 'Normal',
    });
  });

  it("lit l'état du capteur à effet Hall à 0", () => {
    const row = parseReferenceLine(
      '20.1,60.2,0.0,152,3,2026-06-03 10:15:02,Evenement_Magnetique',
    );
    expect(row.hallState).toBe(0);
    expect(row.clusterId).toBe(3);
  });

  it('refuse une ligne incomplète', () => {
    expect(() =>
      parseReferenceLine('19.6,65.7,1.0,150,0,2026-06-01 00:00:00'),
    ).toThrow(/7 colonnes/);
  });

  it('refuse une valeur non numérique', () => {
    expect(() =>
      parseReferenceLine('abc,65.7,1.0,150,0,2026-06-01 00:00:00,Normal'),
    ).toThrow(/DHT22_Temperature_C/);
  });

  it('refuse un état Hall non entier', () => {
    expect(() =>
      parseReferenceLine('19.6,65.7,0.5,150,0,2026-06-01 00:00:00,Normal'),
    ).toThrow(/Hall_Sensor_State/);
  });

  it('refuse un horodatage mal formé', () => {
    expect(() =>
      parseReferenceLine('19.6,65.7,1.0,150,0,01/06/2026 00:00,Normal'),
    ).toThrow(/Timestamp/);
  });
});
