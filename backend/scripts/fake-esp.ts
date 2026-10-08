// Faux boîtier : se comporte comme le firmware sur MQTT (GUIDELINES §5), pour
// travailler sans matériel. Publie status / telemetry / events, applique la
// config retained et acquitte les commandes.
//
//   npm run sim:esp                      boîtier SX-001, mesures toutes les 20 s
//   npm run sim:esp -- --auto            + détections et anomalies aléatoires
//   npm run sim:esp -- --id SX-002 --interval 5
//   npm run sim:esp -- --interval 5 --lock-interval   garde 5 s même si la config du backend dit autre chose
//   npm run sim:esp -- --auto --anomaly-every 120   une anomalie toutes les 2 min en moyenne (0 = aucune)
//
// Au clavier (lettre puis Entrée) :
//   détections, envoyées en événement comme le firmware :
//     m mouvement, i présence IR, t sabotage, f panne capteur
//   anomalies d'environnement, visibles seulement dans les mesures (voir ANOMALIES) :
//     g fuite de gaz, b incendie, p pluie, a aimant
//   q quitter
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';

const { values: args } = parseArgs({
  options: {
    id: { type: 'string', default: 'SX-001' },
    interval: { type: 'string', default: '20' },
    auto: { type: 'boolean', default: false },
    'lock-interval': { type: 'boolean', default: false },
    'anomaly-every': { type: 'string', default: '300' },
  },
});

const DEVICE_ID = args.id;
const TOPIC = `sentinel/v1/${DEVICE_ID}`;
const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SAMPLE_EVERY_S = 2;
const BOOT_AT = Date.now();

let intervalS = Math.max(1, Number(args.interval) || 20);
let armed = true;
let seq = 0;
let timer: NodeJS.Timeout | undefined;
let motionCount = 0;
let irCount = 0;

// Anomalies d'environnement : le boîtier n'envoie aucun événement, seules ses
// mesures changent. C'est le service de prévision qui les reconnaît dans
// telemetry (plus proche voisin de model_reference_data) et crée l'alerte
// ANOMALY_DETECTED. Les valeurs visées sont au cœur de chaque étiquette du jeu
// de référence ; une mesure absente garde sa valeur de repos.
interface Anomaly {
  label: string;
  temp?: number;
  hum?: number;
  gas?: number;
  // Écart du capteur Hall par rapport au repos (pôle au hasard).
  mag?: () => number;
}
const ANOMALIES: Record<string, Anomaly> = {
  g: { label: 'fuite de gaz', gas: 650 },
  b: { label: 'incendie', temp: 89, hum: 5.5, gas: 950 },
  p: { label: 'pluie', temp: 17.5, hum: 88 },
  a: {
    label: 'aimant',
    mag: () => (Math.random() < 0.5 ? -1 : 1) * Math.round(rand(150, 350)),
  },
};
// Durée d'une anomalie : au moins un résumé entier.
const ANOMALY_S = 30;
const anomalyEveryS = Math.max(0, Number(args['anomaly-every']) || 0);
// Anomalie en cours : ses valeurs, l'écart Hall tiré, les résumés restants.
let anomaly: (Anomaly & { magOffset: number; left: number }) | undefined;
const seenCommands = new Set<string>();

const log = (msg: string) =>
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const round1 = (v: number) => Math.round(v * 10) / 10;

// Marche aléatoire ramenée vers une valeur de repos ; pendant une anomalie, la
// lecture oscille autour de la valeur visée.
function sensor(rest: number, step: number) {
  let value = rest;
  return (target?: number) => {
    if (target !== undefined) return target + rand(-step, step);
    value += rand(-step, step) + (rest - value) * 0.05;
    return value;
  };
}
const readTemp = sensor(22, 0.15);
const readHum = sensor(45, 0.4);
// MQ2 : ~150 au repos, comme les mesures « Normal » du jeu de référence IA
// (model_reference_data) ; vers 300 le service de prévision y voit déjà une fuite.
const readGas = sensor(150, 3);
// OH49E : ~512 au repos (VCC/2 sur un ADC 10 bits), l'aimant décale la valeur.
const readMag = sensor(512, 2);

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
  const now = anomaly;
  const gas = () => Math.min(32767, Math.max(0, readGas(now?.gas)));
  const mag = () =>
    Math.min(1023, Math.max(0, readMag() + (now?.magOffset ?? 0)));
  const msg = {
    seq: seq++,
    uptime_ms: Date.now() - BOOT_AT,
    interval_s: intervalS,
    samples,
    temperature_c: summary(() => readTemp(now?.temp), round1, samples),
    humidity_pct: summary(() => readHum(now?.hum), round1, samples),
    gas_raw: summary(gas, Math.round, samples),
    magnetic_raw: summary(mag, Math.round, samples),
    motion_count: motionCount,
    ir_count: irCount,
    rssi_dbm: Math.round(rand(-70, -55)),
  };
  publish('telemetry', msg);
  log(
    `→ telemetry ${msg.temperature_c.last} °C, ${msg.humidity_pct.last} %, gaz ${msg.gas_raw.last}, mag ${msg.magnetic_raw.last}${now ? ` (anomalie : ${now.label})` : ''}`,
  );
  motionCount = 0;
  irCount = 0;
  if (now && --now.left <= 0) {
    anomaly = undefined;
    log(`Fin de l'anomalie « ${now.label} », retour aux valeurs de repos`);
  }
}

function startAnomaly(key: string) {
  const def = ANOMALIES[key];
  const left = Math.max(1, Math.ceil(ANOMALY_S / intervalS));
  anomaly = { ...def, magOffset: def.mag?.() ?? 0, left };
  log(
    `Anomalie « ${def.label} » sur ${left} résumé(s), à partir du prochain : aucun événement, c'est la prévision qui alerte`,
  );
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
  t: () => event('TAMPER'),
  f: () => event('SENSOR_FAILURE', { sensor: 'dht22' }),
  ...Object.fromEntries(
    Object.keys(ANOMALIES).map((key) => [key, () => startAnomaly(key)]),
  ),
};

function autoEvents() {
  // En moyenne un mouvement par minute, une présence IR toutes les deux minutes.
  if (Math.random() < intervalS / 60) triggers.m();
  if (Math.random() < intervalS / 120) triggers.i();
  // Une anomalie d'environnement au hasard, jamais deux à la fois.
  if (!anomaly && anomalyEveryS && Math.random() < intervalS / anomalyEveryS) {
    const keys = Object.keys(ANOMALIES);
    startAnomaly(keys[Math.floor(Math.random() * keys.length)]);
  }
}

function onConfig(json: Record<string, unknown>) {
  if (typeof json.armed === 'boolean') armed = json.armed;
  const ignored =
    args['lock-interval'] &&
    typeof json.interval_s === 'number' &&
    json.interval_s !== intervalS;
  if (
    !args['lock-interval'] &&
    typeof json.interval_s === 'number' &&
    json.interval_s >= 1 &&
    json.interval_s !== intervalS
  ) {
    intervalS = json.interval_s;
    schedule();
  }
  log(
    `← config : mesures toutes les ${intervalS} s${ignored ? ` (--lock-interval : ${json.interval_s} s demandé, ignoré)` : ''}, ${armed ? 'armé' : 'désarmé'}`,
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
  else if (key)
    log('Touches : m, i, t, f (détections), g, b, p, a (anomalies), q');
});
process.on('SIGINT', () => void quit());
// docker stop : sans cela le boîtier passerait hors ligne par son Last Will.
process.on('SIGTERM', () => void quit());
