// Tests de bout en bout sur une vraie base TimescaleDB migrée et seedée.
// Lancés seulement si E2E_DATABASE_URL est défini (compte sentinel_app), par ex. :
//   E2E_DATABASE_URL=postgres://sentinel_app:...@localhost:5432/sentinel \
//   E2E_ADMIN_USERNAME=admin E2E_ADMIN_PASSWORD=... npm run test:e2e
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const DB_URL = process.env.E2E_DATABASE_URL;
const SERVICE_KEY = 'e2e-service-key-0123456789';
const VISION_KEY = 'e2e-vision-key-0123456789';

describe.skipIf(!DB_URL)('API (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB_URL,
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0000',
      MQTT_ENABLED: 'false',
      SERVICE_API_KEYS: `e2e=${SERVICE_KEY},vision=${VISION_KEY}`,
    });
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        username: process.env.E2E_ADMIN_USERNAME,
        password: process.env.E2E_ADMIN_PASSWORD,
      })
      .expect(200);
    token = res.body.access_token;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body).toMatchObject({ database: 'up', broker: 'disabled' });
  });

  it('refuse les routes protégées sans jeton', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/devices')
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('liste les boîtiers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.map((d: { id: string }) => d.id)).toContain('SX-SIM');
  });

  it('POST /alerts : 201 puis 200 pour un doublon', async () => {
    const body = {
      device_id: 'SX-SIM',
      source: 'ml',
      type: 'ANOMALY_DETECTED',
      severity: 'warning',
    };
    const server = app.getHttpServer();
    const first = await request(server)
      .post('/api/v1/alerts')
      .set('X-Api-Key', SERVICE_KEY)
      .send(body);
    expect([200, 201]).toContain(first.status);
    const second = await request(server)
      .post('/api/v1/alerts')
      .set('X-Api-Key', SERVICE_KEY)
      .send(body)
      .expect(200);
    expect(second.body.occurrences).toBeGreaterThan(1);
  });

  it('refuse une commande vers un boîtier hors ligne', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/devices/SX-SIM/commands')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'LED', params: { color: 'green' } })
      .expect(409);
    expect(res.body.error.code).toBe('DEVICE_OFFLINE');
  });

  it("POST /persons/unknowns : mémorise l'inconnu et son empreinte", async () => {
    const id = randomUUID();
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/persons/unknowns')
      .set('X-Api-Key', VISION_KEY)
      .send({
        id,
        display_name: `Inconnu-${id.slice(0, 4)}`,
        embedding: Array.from({ length: 128 }, (_, i) => i / 128),
        model_version: 'e2e',
      })
      .expect(201);
    expect(created.body).toMatchObject({ id, status: 'unknown' });

    const list = await request(server)
      .get('/api/v1/persons?status=unknown')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const person = list.body.find((p: { id: string }) => p.id === id);
    expect(person?.embeddings_count).toBe(1);

    await request(server)
      .delete(`/api/v1/persons/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });
});
