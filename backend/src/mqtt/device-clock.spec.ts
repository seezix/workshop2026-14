import { DeviceClock } from './device-clock.js';

describe('DeviceClock', () => {
  const T0 = Date.parse('2026-10-07T14:00:00.000Z');

  it('date à la réception un message en direct', () => {
    const clock = new DeviceClock();
    expect(clock.resolve('SX-001', 10_000, T0)).toBe(T0);
    expect(clock.resolve('SX-001', 70_000, T0 + 60_000)).toBe(T0 + 60_000);
  });

  it('date à la réception sans uptime', () => {
    expect(new DeviceClock().resolve('SX-001', undefined, T0)).toBe(T0);
  });

  it("recalcule l'heure d'un événement du tampon hors ligne", () => {
    const clock = new DeviceClock();
    clock.resolve('SX-001', 100_000, T0);
    // Coupure réseau de 5 min ; l'événement a eu lieu 30 s après la référence
    // mais n'arrive qu'à la reconnexion.
    expect(clock.resolve('SX-001', 130_000, T0 + 300_000)).toBe(T0 + 30_000);
    // Le message suivant, en direct, redevient la référence.
    expect(clock.resolve('SX-001', 400_000, T0 + 300_000)).toBe(T0 + 300_000);
  });

  it('repart de zéro après un redémarrage', () => {
    const clock = new DeviceClock();
    clock.resolve('SX-001', 3_600_000, T0);
    // uptime revenu en arrière : redémarrage, on date à la réception.
    expect(clock.resolve('SX-001', 2_000, T0 + 120_000)).toBe(T0 + 120_000);
  });

  it('isole les boîtiers', () => {
    const clock = new DeviceClock();
    clock.resolve('SX-001', 100_000, T0);
    expect(clock.resolve('SX-002', 130_000, T0 + 300_000)).toBe(T0 + 300_000);
  });

  it('reset() oublie la référence (BOOT)', () => {
    const clock = new DeviceClock();
    clock.resolve('SX-001', 100_000, T0);
    clock.reset('SX-001');
    expect(clock.resolve('SX-001', 130_000, T0 + 300_000)).toBe(T0 + 300_000);
  });
});
