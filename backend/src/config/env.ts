import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Compte sentinel_app (jamais le propriétaire de la base).
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET doit faire au moins 32 caractères'),
  JWT_TTL_S: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 3600),
  // Origine du dashboard, seule autorisée par CORS.
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default(true),
  // Proxys de confiance pour X-Forwarded-For (nginx dans le réseau Docker).
  TRUST_PROXY: z.string().default('loopback, uniquelocal'),
  MQTT_ENABLED: bool.default(true),
  MQTT_URL: z.string().default('mqtts://mosquitto:8883'),
  MQTT_USERNAME: z.string().default('backend'),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_CA_FILE: z.string().optional(),
  MQTT_REJECT_UNAUTHORIZED: bool.default(true),
  // Clés des services internes : "vision=xxx,anomaly=yyy".
  SERVICE_API_KEYS: z.string().default(''),
  // URL interne de vision.py pour l'enregistrement par webcam.
  VISION_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Configuration invalide :\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** "vision=abc,anomaly=def" → Map(clé → nom du service) */
export function parseServiceKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const idx = entry.indexOf('=');
    if (idx <= 0)
      throw new Error(
        `SERVICE_API_KEYS : entrée invalide « ${entry.slice(0, 20)} »`,
      );
    const name = entry.slice(0, idx).trim();
    const key = entry.slice(idx + 1).trim();
    if (!/^[a-z0-9_-]+$/.test(name))
      throw new Error(`SERVICE_API_KEYS : nom de service invalide « ${name} »`);
    if (key.length < 24)
      throw new Error(
        `SERVICE_API_KEYS : la clé de « ${name} » doit faire au moins 24 caractères`,
      );
    keys.set(key, name);
  }
  return keys;
}

export const ENV = Symbol('ENV');
