import type { AlertListener, AlertsService } from '../alerts/alerts.service.js';
import type { CommandsService } from '../commands/commands.service.js';
import { ApiError } from '../common/api-error.js';
import type { Database } from '../db/database.module.js';
import type { Alert } from '../db/schema.js';
import { RulesService, SIGNAL_MAX_AGE_MS } from './rules.service.js';

function setup() {
  let listener: AlertListener | undefined;
  const alerts = {
    onAlert: (l: AlertListener) => {
      listener = l;
    },
  };
  const commands = { issue: vi.fn().mockResolvedValue({}) };
  new RulesService(
    {} as Database,
    alerts as unknown as AlertsService,
    commands as unknown as CommandsService,
  ).onModuleInit();
  return { commands, notify: listener! };
}

// Source ml : hors règle d'intrusion, seule la règle signal réagit.
const alert = (severity: Alert['severity']) =>
  ({
    deviceId: 'SX-001',
    source: 'ml',
    type: 'ANOMALY_DETECTED',
    severity,
  }) as Alert;

describe('RulesService : signal du boîtier sur alerte', () => {
  it('critical : alarme et LED rouge', async () => {
    const { commands, notify } = setup();
    await notify(alert('critical'), 'created', new Date());
    expect(commands.issue.mock.calls).toEqual([
      [
        'SX-001',
        { action: 'BUZZER', params: { mode: 'beep', duration_ms: 10_000 } },
        'rule:alert-critical',
      ],
      [
        'SX-001',
        { action: 'LED', params: { color: 'red', blink: true } },
        'rule:alert-critical',
      ],
    ]);
  });

  it('warning : flash rouge, sans buzzer', async () => {
    const { commands, notify } = setup();
    await notify(alert('warning'), 'created', new Date());
    expect(commands.issue.mock.calls).toEqual([
      [
        'SX-001',
        { action: 'LED', params: { color: 'red', duration_ms: 2_000 } },
        'rule:alert-warning',
      ],
    ]);
  });

  it('info : flash vert', async () => {
    const { commands, notify } = setup();
    await notify(alert('info'), 'created', new Date());
    expect(commands.issue.mock.calls).toEqual([
      [
        'SX-001',
        { action: 'LED', params: { color: 'green', duration_ms: 2_000 } },
        'rule:alert-info',
      ],
    ]);
  });

  it('ne signale ni un doublon ni une alerte rejouée', async () => {
    const { commands, notify } = setup();
    await notify(alert('critical'), 'deduplicated', new Date());
    await notify(
      alert('critical'),
      'created',
      new Date(Date.now() - SIGNAL_MAX_AGE_MS - 1_000),
    );
    expect(commands.issue).not.toHaveBeenCalled();
  });

  it('boîtier hors ligne : abandonne sans erreur', async () => {
    const { commands, notify } = setup();
    commands.issue.mockRejectedValue(
      new ApiError('DEVICE_OFFLINE', 'Le boîtier est hors ligne'),
    );
    await expect(
      notify(alert('critical'), 'created', new Date()),
    ).resolves.toBeUndefined();
    expect(commands.issue).toHaveBeenCalledTimes(1);
  });
});
