import type { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/access.js';
import type { ApiError, ErrorBody } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/database.module.js';
import { PersonsService } from './persons.module.js';

const VISION_KEY = 'v'.repeat(24);
const ENV = {
  VISION_URL: 'http://vision.test:5001',
  SERVICE_API_KEYS: `anomaly=${'a'.repeat(24)},vision=${VISION_KEY}`,
};
const BODY = { display_name: 'Ada Lovelace', consent: true as const };
const ADMIN: Principal = {
  kind: 'user',
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  role: 'admin',
};

function serviceFor(env: Partial<Env>) {
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new PersonsService(
    {} as Database,
    env as Env,
    audit as unknown as AuditService,
  );
  return { service, audit };
}

function visionReplies(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('aurait dû échouer');
}

const messageOf = (err: ApiError) =>
  (err.getResponse() as ErrorBody).error.message;

describe('PersonsService.enroll', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('relaie à vision.py avec la clé du service vision', async () => {
    const fetchMock = visionReplies(201, { person_id: 'p-1', embeddings: 5 });
    const { service, audit } = serviceFor(ENV);

    const result = await service.enroll(BODY, ADMIN, '127.0.0.1');

    expect(result).toEqual({
      person_id: 'p-1',
      status: 'authorized',
      embeddings: 5,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://vision.test:5001/enroll');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      VISION_KEY,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      display_name: 'Ada Lovelace',
      created_by: ADMIN.id,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'person.enroll' }),
    );
  });

  it('remonte le message de vision.py quand la capture échoue', async () => {
    visionReplies(422, { message: 'Aucun visage exploitable' });
    const { service } = serviceFor(ENV);

    const err = await failure(service.enroll(BODY, ADMIN));

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(messageOf(err)).toBe('Aucun visage exploitable');
  });

  it('503 sans clé du service vision, sans appeler vision.py', async () => {
    const fetchMock = visionReplies(201, {});
    const { service } = serviceFor({ ...ENV, SERVICE_API_KEYS: '' });

    const err = await failure(service.enroll(BODY, ADMIN));

    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503 si vision.py est injoignable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    const { service } = serviceFor(ENV);

    const err = await failure(service.enroll(BODY, ADMIN));

    expect(err.code).toBe('SERVICE_UNAVAILABLE');
  });
});
