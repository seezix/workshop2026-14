// Faux boîtier : se comporte comme le firmware sur MQTT (GUIDELINES §5), pour
// travailler sans matériel. Publie status / telemetry / events, applique la
// config retained et acquitte les commandes.
//
//   npm run sim:esp                      boîtier SX-001, mesures toutes les 10 s
//   npm run sim:esp -- --auto            + détections aléatoires
//   npm run sim:esp -- --id SX-002 --interval 5
//
// Au clavier (lettre puis Entrée) : m mouvement, i présence IR, g gaz,
// t sabotage, f panne capteur, q quitter.
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';

const { values: args } = parseArgs({
  options: {
    id: { type: 'string', default: 'SX-001' },
    interval: { type: 'string', default: '10' },
    auto: { type: 'boolean', default: false },
  },
});

const DEVICE_ID = args.id;
const TOPIC = `sentinel/v1/${DEVICE_ID}`;
const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SAMPLE_EVERY_S = 2;
const BOOT_AT = Date.now();

let intervalS = Math.max(1, Number(args.interval) || 10);
let armed = true;
let seq = 0;
let timer: NodeJS.Timeout | undefined;
let motionCount = 0;
let irCount = 0;
// Hausse de gaz en cours : s'ajoute aux lectures puis retombe à chaque période.
let gasBoost = 0;
const seenCommands = new Set<string>();

const log = (msg: string) =>
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const round1 = (v: number) => Math.round(v * 10) / 10;

// Marche aléatoire ramenée vers une valeur de repos.
function sensor(rest: number, step: number) {
  let value = rest;
  return () => {
    value += rand(-step, step) + (rest - value) * 0.05;
    return value;
  };
}
const readTemp = sensor(22, 0.15);
const readHum = sensor(45, 0.4);
const readGas = sensor(300, 6);

function summary(read: () => number, digits: (v: number) => number, n: number) {
  const values = Array.from({ length: n }, read);
  return {
    avg: digits(values.reduce((a, b) => a + b, 0) / n),
    min: digits(Math.min(...values)),
    max: digits(Math.max(...values)),
    last: digits(values[n - 1]),
  };
}

const client = mqtt.connect(MQTT_URL, {
  clientId: `fake-esp-${DEVICE_ID}`,
  // En production l'ACL Mosquitto attend username = device_id.
  username: DEVICE_ID,
  password: process.env.FAKE_ESP_PASSWORD,
  reconnectPeriod: 3_000,
  rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false',
  will: {
    topic: `${TOPIC}/status`,
    payload: JSON.stringify({ state: 'offline' }),
    qos: 1,
    retain: true,
  },
});

function publish(channel: string, payload: object, retain = false) {
  client.publish(`${TOPIC}/${channel}`, JSON.stringify(payload), {
    qos: channel === 'status' ? 1 : 0,
    retain,
  });
}

function event(type: string, extra: object = {}) {
  publish('events', {
    seq: seq++,
    uptime_ms: Date.now() - BOOT_AT,
    type,
    ...extra,
  });
  log(`→ events ${type}${armed ? '' : ' (désarmé)'}`);
}

function telemetry() {
  const samples = Math.max(1, Math.round(intervalS / SAMPLE_EVERY_S));
  const gas = () => Math.min(32767, Math.max(0, readGas() + gasBoost));
  const msg = {
    seq: seq++,
    uptime_ms: Date.now() - BOOT_AT,
    interval_s: intervalS,
    samples,
    temperature_c: summary(readTemp, round1, samples),
    humidity_pct: summary(readHum, round1, samples),
    gas_raw: summary(gas, Math.round, samples),
    motion_count: motionCount,
    ir_count: irCount,
    rssi_dbm: Math.round(rand(-70, -55)),
  };
  publish('telemetry', msg);
  log(
    `→ telemetry ${msg.temperature_c.last} °C, ${msg.humidity_pct.last} %, gaz ${msg.gas_raw.last}`,
  );
  motionCount = 0;
  irCount = 0;
  gasBoost = Math.max(0, gasBoost - 150);
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (args.auto) autoEvents();
    telemetry();
  }, intervalS * 1000);
}

const triggers: Record<string, () => void> = {
  m: () => {
    motionCount++;
    event('MOTION_DETECTED');
  },
  i: () => {
    irCount++;
    event('IR_DETECTED');
    const duration = Math.round(rand(1_000, 6_000));
    setTimeout(() => event('IR_CLEARED', { duration_ms: duration }), duration);
  },
  g: () => {
    gasBoost = 450;
    event('GAS_RISE');
  },
  t: () => event('TAMPER'),
  f: () => event('SENSOR_FAILURE', { sensor: 'dht22' }),
};

function autoEvents() {
  // En moyenne un mouvement par minute, une présence IR toutes les deux minutes.
  if (Math.random() < intervalS / 60) triggers.m();
  if (Math.random() < intervalS / 120) triggers.i();
}

function onConfig(json: Record<string, unknown>) {
  if (typeof json.armed === 'boolean') armed = json.armed;
  if (
    typeof json.interval_s === 'number' &&
    json.interval_s >= 1 &&
    json.interval_s !== intervalS
  ) {
    intervalS = json.interval_s;
    schedule();
  }
  log(
    `← config : mesures toutes les ${intervalS} s, ${armed ? 'armé' : 'désarmé'}`,
  );
}

function onCommand(json: Record<string, unknown>) {
  const cmdId = typeof json.cmd_id === 'string' ? json.cmd_id : undefined;
  if (!cmdId) return;
  const ack = (status: 'done' | 'rejected', reason?: string) => {
    publish('cmd/ack', {
      cmd_id: cmdId,
      status,
      ...(reason ? { reason } : {}),
    });
    log(`→ cmd/ack ${cmdId} ${status}${reason ? ` (${reason})` : ''}`);
  };
  if (seenCommands.has(cmdId)) return ack('rejected', 'duplicate');
  seenCommands.add(cmdId);

  const params = (json.params ?? {}) as Record<string, unknown>;
  if (json.action === 'BUZZER') {
    if (!['on', 'off', 'beep'].includes(params.mode as string))
      return ack('rejected', 'invalid_params');
    log(`← cmd BUZZER ${params.mode} ${params.duration_ms ?? ''}`);
  } else if (json.action === 'LED') {
    if (!['red', 'green', 'off'].includes(params.color as string))
      return ack('rejected', 'invalid_params');
    log(`← cmd LED ${params.color}${params.blink ? ' clignotante' : ''}`);
  } else {
    return ack('rejected', 'unknown_action');
  }
  ack('done');
}

client.on('connect', () => {
  log(`${DEVICE_ID} connecté à ${MQTT_URL}`);
  client.subscribe([`${TOPIC}/cmd`, `${TOPIC}/config`], { qos: 1 });
  publish(
    'status',
    { state: 'online', fw: 'sim-1.0.0', ip: '127.0.0.1' },
    true,
  );
  event('BOOT');
  schedule();
  telemetry();
});
client.on('offline', () => log('Broker injoignable, nouvelle tentative…'));
client.on('error', (err) => log(`Erreur MQTT : ${err.message}`));
client.on('message', (topic, payload) => {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(payload.toString('utf8'));
  } catch {
    return;
  }
  if (topic.endsWith('/config')) onConfig(json);
  else if (topic.endsWith('/cmd')) onCommand(json);
});

async function quit() {
  clearInterval(timer);
  // Arrêt propre : le Last Will ne part que sur une coupure brutale.
  await client.publishAsync(
    `${TOPIC}/status`,
    JSON.stringify({ state: 'offline' }),
    { qos: 1, retain: true },
  );
  await client.endAsync();
  process.exit(0);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const key = line.trim().toLowerCase();
  if (key === 'q') void quit();
  else if (triggers[key]) triggers[key]();
  else if (key) log('Touches : m, i, g, t, f, q');
});
process.on('SIGINT', () => void quit());
