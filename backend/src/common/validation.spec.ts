import { CommandSchema } from '../commands/commands.service.js';
import { parseServiceKeys } from '../config/env.js';
import { TelemetryMessage } from '../mqtt/messages.js';
import { pickResolution } from '../telemetry/telemetry.dto.js';
import { ApiError } from './api-error.js';
import { ZodPipe } from './zod.pipe.js';

describe('pickResolution', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const plus = (h: number) => new Date(from.getTime() + h * 3600_000);

  it('brut jusqu’à 24 h, 1 h jusqu’à 30 jours, 1 jour au-delà', () => {
    expect(pickResolution(from, plus(24))).toBe('raw');
    expect(pickResolution(from, plus(25))).toBe('1h');
    expect(pickResolution(from, plus(30 * 24))).toBe('1h');
    expect(pickResolution(from, plus(30 * 24 + 1))).toBe('1d');
  });
});

describe('parseServiceKeys', () => {
  it('associe chaque clé à son service', () => {
    const keys = parseServiceKeys(
      'vision=aaaaaaaaaaaaaaaaaaaaaaaa, anomaly=bbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(keys.get('aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('vision');
    expect(keys.get('bbbbbbbbbbbbbbbbbbbbbbbb')).toBe('anomaly');
  });

  it('accepte une liste vide', () => {
    expect(parseServiceKeys('').size).toBe(0);
  });

  it('refuse une clé trop courte', () => {
    expect(() => parseServiceKeys('vision=court')).toThrow(/24 caractères/);
  });
});

describe('CommandSchema', () => {
  const ok = (v: unknown) => CommandSchema.safeParse(v).success;

  it('accepte les actions du contrat', () => {
    expect(
      ok({ action: 'BUZZER', params: { mode: 'beep', duration_ms: 3000 } }),
    ).toBe(true);
    expect(ok({ action: 'LED', params: { color: 'red', blink: true } })).toBe(
      true,
    );
  });

  it('applique les limites', () => {
    expect(
      ok({ action: 'BUZZER', params: { mode: 'beep', duration_ms: 10_001 } }),
    ).toBe(false);
    expect(ok({ action: 'LED', params: { color: 'blue' } })).toBe(false);
    expect(ok({ action: 'REBOOT', params: {} })).toBe(false);
    expect(ok({ action: 'LED', params: { color: 'red', extra: 1 } })).toBe(
      false,
    );
  });
});

describe('TelemetryMessage', () => {
  it('accepte le résumé du contrat et les valeurs null', () => {
    const parsed = TelemetryMessage.parse({
      seq: 57,
      uptime_ms: 3600123,
      interval_s: 60,
      samples: 30,
      temperature_c: { avg: 23.4, min: 23.1, max: 23.9, last: 23.6 },
      humidity_pct: { avg: null, min: null, max: null, last: null },
      gas_raw: { avg: 312, min: 298, max: 355, last: 305 },
      motion_count: 2,
      ir_count: 3,
      rssi_dbm: -61,
    });
    expect(parsed.humidity_pct?.avg).toBeNull();
  });

  it('refuse un résumé sans interval_s', () => {
    expect(TelemetryMessage.safeParse({ samples: 3 }).success).toBe(false);
  });
});

describe('ZodPipe', () => {
  it('renvoie une erreur VALIDATION_ERROR détaillée', () => {
    const pipe = new ZodPipe(CommandSchema);
    try {
      pipe.transform({ action: 'LED', params: { color: 'blue' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).getStatus()).toBe(400);
      expect((err as ApiError).getResponse()).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          details: [{ field: 'params.color' }],
        },
      });
    }
  });
});
