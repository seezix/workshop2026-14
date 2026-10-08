import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Access, CurrentPrincipal, type Principal } from '../auth/access.js';
import { ApiError } from '../common/api-error.js';
import { ApiOperation } from '@nestjs/swagger';
import { ZodPipe, zDeviceId, zUuid } from '../common/zod.pipe.js';
import { ENV, type Env, parseServiceKeys } from '../config/env.js';
import { DB, type Database } from '../db/database.module.js';
import { faceSightings, persons } from '../db/schema.js';

// Données biométriques (GUIDELINES §8) : l'empreinte n'est jamais renvoyée.

export const UNKNOWN_TTL_MS = 72 * 3600 * 1000;
const PURGE_EVERY_MS = 10 * 60 * 1000;

type PersonRow = typeof persons.$inferSelect & { embeddingsCount?: number };

function toPersonDto(p: PersonRow) {
  return {
    id: p.id,
    display_name: p.displayName,
    status: p.status,
    consent_at: p.consentAt,
    first_seen_at: p.firstSeenAt,
    last_seen_at: p.lastSeenAt,
    visit_count: p.visitCount,
    expires_at: p.expiresAt,
    created_by: p.createdBy,
    ...(p.embeddingsCount !== undefined
      ? { embeddings_count: p.embeddingsCount }
      : {}),
  };
}

const ListQuery = z.object({
  status: z.enum(['authorized', 'unknown', 'denied']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const PatchBody = z
  .object({
    display_name: z.string().trim().min(1).max(64).nullable().optional(),
    status: z.enum(['authorized', 'unknown', 'denied']).optional(),
    // Obligatoire pour passer en authorized si aucun consentement n'est enregistré.
    consent: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'Aucune modification demandée',
  });

const EnrollBody = z
  .object({
    display_name: z.string().trim().min(1).max(64),
    consent: z.literal(true, {
      message: 'Le consentement de la personne est obligatoire',
    }),
    device_id: z.string().optional(),
  })
  .strict();

// Écritures de vision.py : il ne touche plus la base directement.
const UnknownBody = z
  .object({
    id: zUuid,
    display_name: z.string().trim().min(1).max(64),
    embedding: z.array(z.number()).length(128),
    model_version: z.string().min(1).max(64),
  })
  .strict();

const SightingStatus = z.enum(['authorized', 'unknown', 'denied']);

const SightingBody = z
  .object({
    person_id: zUuid,
    device_id: zDeviceId,
    similarity: z.number(),
    status_at_time: SightingStatus,
    track_id: z.number().int().nullable().optional(),
  })
  .strict();

const SightingPatch = z
  .object({
    person_id: zUuid.optional(),
    similarity: z.number().optional(),
    status_at_time: SightingStatus.optional(),
    alert_id: zUuid.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'Aucune modification demandée',
  });

const zSightingId = z.coerce.number().int().positive();

/** Seul le service vision écrit les personnes vues par la caméra. */
function requireVision(principal: Principal | undefined) {
  if (principal?.kind !== 'service' || principal.name !== 'vision')
    throw new ApiError('FORBIDDEN', 'Réservé au service vision');
}

@Injectable()
export class PersonsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Persons');
  private purgeTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.purgeTimer = setInterval(
      () => void this.purgeExpiredUnknowns(),
      PURGE_EVERY_MS,
    );
    void this.purgeExpiredUnknowns();
  }

  onModuleDestroy() {
    clearInterval(this.purgeTimer);
  }

  async list(status: PersonRow['status'] | undefined, limit: number) {
    const count = sql<number>`(SELECT count(*)::integer FROM face_embeddings fe WHERE fe.person_id = persons.id)`;
    const rows = await this.db
      .select({
        id: persons.id,
        displayName: persons.displayName,
        status: persons.status,
        consentAt: persons.consentAt,
        firstSeenAt: persons.firstSeenAt,
        lastSeenAt: persons.lastSeenAt,
        visitCount: persons.visitCount,
        expiresAt: persons.expiresAt,
        createdBy: persons.createdBy,
        embeddingsCount: count,
      })
      .from(persons)
      .where(status ? eq(persons.status, status) : undefined)
      .orderBy(desc(persons.lastSeenAt))
      .limit(limit);
    return rows.map(toPersonDto);
  }

  async get(id: string) {
    const [person] = await this.db
      .select()
      .from(persons)
      .where(eq(persons.id, id))
      .limit(1);
    if (!person) throw ApiError.notFound('Personne');
    return person;
  }

  async sightings(id: string, limit: number) {
    await this.get(id);
    const rows = await this.db
      .select()
      .from(faceSightings)
      .where(eq(faceSightings.personId, id))
      .orderBy(desc(faceSightings.time))
      .limit(limit);
    return rows.map((s) => ({
      id: s.id,
      time: s.time,
      person_id: s.personId,
      device_id: s.deviceId,
      similarity: s.similarity,
      status_at_time: s.statusAtTime,
      track_id: s.trackId,
      alert_id: s.alertId,
    }));
  }

  async update(
    id: string,
    patch: z.infer<typeof PatchBody>,
    principal: Principal,
    ip?: string,
  ) {
    const current = await this.get(id);
    const status = patch.status ?? current.status;
    let consentAt = current.consentAt;
    if (status === 'authorized' && !consentAt) {
      if (!patch.consent) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'Consentement requis pour autoriser une personne',
          [{ field: 'consent', message: 'consent: true attendu' }],
        );
      }
      consentAt = new Date();
    }
    // Seuls les inconnus expirent (72 h après leur dernier passage).
    const expiresAt =
      status === 'unknown'
        ? new Date(current.lastSeenAt.getTime() + UNKNOWN_TTL_MS)
        : null;

    const [updated] = await this.db
      .update(persons)
      .set({
        status,
        consentAt,
        expiresAt,
        ...(patch.display_name !== undefined
          ? { displayName: patch.display_name }
          : {}),
      })
      .where(eq(persons.id, id))
      .returning();

    await this.audit.log({
      action: 'person.update',
      principal,
      ip,
      details: {
        person_id: id,
        before: { status: current.status },
        after: {
          status,
          display_name_changed: patch.display_name !== undefined,
        },
      },
    });
    return toPersonDto(updated);
  }

  /** Effacement complet : empreintes et passages partent en cascade. */
  async remove(id: string, principal: Principal, ip?: string) {
    const current = await this.get(id);
    await this.db.delete(persons).where(eq(persons.id, id));
    await this.audit.log({
      action: 'person.delete',
      principal,
      ip,
      details: { person_id: id, status: current.status },
    });
  }

  /** L'enregistrement par webcam est fait par vision.py ; le backend relaie et trace. */
  async enroll(
    body: z.infer<typeof EnrollBody>,
    principal: Principal,
    ip?: string,
  ) {
    // vision.py n'accepte /enroll qu'avec sa propre clé de service : sans elle,
    // n'importe qui sur le réseau pourrait s'ajouter comme personne autorisée.
    const visionKey = [...parseServiceKeys(this.env.SERVICE_API_KEYS)].find(
      ([, name]) => name === 'vision',
    )?.[0];
    if (!this.env.VISION_URL || !visionKey)
      throw new ApiError('SERVICE_UNAVAILABLE', 'Service vision non configuré');
    let res: globalThis.Response;
    try {
      res = await fetch(new URL('/enroll', this.env.VISION_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': visionKey,
        },
        body: JSON.stringify({
          display_name: body.display_name,
          consent_at: new Date().toISOString(),
          created_by: principal.kind === 'user' ? principal.id : null,
          device_id: body.device_id ?? null,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      this.logger.warn(`vision.py injoignable : ${(err as Error).message}`);
      throw new ApiError('SERVICE_UNAVAILABLE', 'Service vision injoignable');
    }
    const payload = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    await this.audit.log({
      action: 'person.enroll',
      principal,
      ip,
      details: {
        display_name: body.display_name,
        vision_status: res.status,
        person_id: payload.person_id ?? null,
      },
    });
    if (!res.ok) {
      throw new ApiError(
        'VALIDATION_ERROR',
        typeof payload.message === 'string'
          ? payload.message.slice(0, 200)
          : 'Enregistrement refusé par vision',
      );
    }
    return {
      person_id: payload.person_id ?? null,
      status: 'authorized',
      embeddings:
        typeof payload.embeddings === 'number' ? payload.embeddings : null,
    };
  }

  /** Inconnu confirmé par vision.py : personne + empreinte « auto », gardées 72 h. */
  async createUnknown(body: z.infer<typeof UnknownBody>) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [person] = await tx
        .insert(persons)
        .values({
          id: body.id,
          displayName: body.display_name,
          status: 'unknown',
          firstSeenAt: now,
          lastSeenAt: now,
          visitCount: 1,
          expiresAt: new Date(now.getTime() + UNKNOWN_TTL_MS),
        })
        .onConflictDoNothing()
        .returning();
      if (!person)
        throw new ApiError('VALIDATION_ERROR', 'Cette personne existe déjà');
      // La colonne embedding n'est pas dans le schéma Drizzle (jamais relue par l'API).
      await tx.execute(
        sql`INSERT INTO face_embeddings (person_id, embedding, model_version, source)
            VALUES (${body.id}, ${body.embedding}::real[], ${body.model_version}, 'auto')`,
      );
      return toPersonDto(person);
    });
  }

  /** Nouveau passage d'une personne reconnue. Un inconnu revu repart pour 72 h. */
  async recordVisit(id: string) {
    const current = await this.get(id);
    const now = new Date();
    const [updated] = await this.db
      .update(persons)
      .set({
        lastSeenAt: now,
        visitCount: sql`${persons.visitCount} + 1`,
        ...(current.status === 'unknown'
          ? { expiresAt: new Date(now.getTime() + UNKNOWN_TTL_MS) }
          : {}),
      })
      .where(eq(persons.id, id))
      .returning();
    return toPersonDto(updated);
  }

  async createSighting(body: z.infer<typeof SightingBody>) {
    await this.get(body.person_id);
    const [row] = await this.db
      .insert(faceSightings)
      .values({
        time: new Date(),
        personId: body.person_id,
        deviceId: body.device_id,
        similarity: body.similarity,
        statusAtTime: body.status_at_time,
        trackId: body.track_id ?? null,
      })
      .returning({ id: faceSightings.id });
    return { id: row.id };
  }

  async updateSighting(id: number, patch: z.infer<typeof SightingPatch>) {
    if (patch.person_id) await this.get(patch.person_id);
    const [row] = await this.db
      .update(faceSightings)
      .set({
        ...(patch.person_id ? { personId: patch.person_id } : {}),
        ...(patch.similarity !== undefined
          ? { similarity: patch.similarity }
          : {}),
        ...(patch.status_at_time ? { statusAtTime: patch.status_at_time } : {}),
        ...(patch.alert_id ? { alertId: patch.alert_id } : {}),
      })
      .where(eq(faceSightings.id, id))
      .returning({ id: faceSightings.id });
    if (!row) throw ApiError.notFound('Passage');
    return { id: row.id };
  }

  async purgeExpiredUnknowns() {
    try {
      const deleted = await this.db
        .delete(persons)
        .where(
          and(eq(persons.status, 'unknown'), lt(persons.expiresAt, new Date())),
        )
        .returning({ id: persons.id });
      if (deleted.length > 0) {
        this.logger.log(`${deleted.length} inconnu(s) purgé(s) après 72 h`);
        await this.audit.log({
          action: 'person.purge',
          actor: 'system',
          details: { count: deleted.length },
        });
      }
    } catch (err) {
      this.logger.error(`Purge des inconnus : ${(err as Error).message}`);
    }
  }
}

@Controller('persons')
@Access({ role: 'operator' })
export class PersonsController {
  constructor(private readonly persons: PersonsService) {}

  @ApiOperation({
    summary: 'Liste des personnes connues de la reconnaissance faciale',
  })
  @Get()
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.persons.list(q.status, q.limit);
  }

  @ApiOperation({ summary: "Passages d'une personne" })
  @Get(':id/sightings')
  sightings(
    @Param('id', new ZodPipe(zUuid)) id: string,
    @Query(
      new ZodPipe(
        z.object({
          limit: z.coerce.number().int().min(1).max(1000).default(200),
        }),
      ),
    )
    q: { limit: number },
  ) {
    return this.persons.sightings(id, q.limit);
  }

  @ApiOperation({
    summary: 'Enregistre un visage par webcam (relayé à vision.py)',
  })
  @Post('enroll')
  @Access({ role: 'admin' })
  @HttpCode(201)
  enroll(
    @Body(new ZodPipe(EnrollBody)) body: z.infer<typeof EnrollBody>,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ) {
    return this.persons.enroll(body, principal, req.ip);
  }

  @ApiOperation({ summary: 'Mémorise un inconnu (service vision)' })
  @Post('unknowns')
  @Access({ services: true })
  @HttpCode(201)
  createUnknown(
    @Body(new ZodPipe(UnknownBody)) body: z.infer<typeof UnknownBody>,
    @CurrentPrincipal() principal: Principal,
  ) {
    requireVision(principal);
    return this.persons.createUnknown(body);
  }

  @ApiOperation({ summary: 'Compte un passage (service vision)' })
  @Post(':id/visits')
  @Access({ services: true })
  @HttpCode(200)
  recordVisit(
    @Param('id', new ZodPipe(zUuid)) id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    requireVision(principal);
    return this.persons.recordVisit(id);
  }

  @ApiOperation({ summary: 'Enregistre un passage (service vision)' })
  @Post('sightings')
  @Access({ services: true })
  @HttpCode(201)
  createSighting(
    @Body(new ZodPipe(SightingBody)) body: z.infer<typeof SightingBody>,
    @CurrentPrincipal() principal: Principal,
  ) {
    requireVision(principal);
    return this.persons.createSighting(body);
  }

  @ApiOperation({
    summary: 'Complète un passage ou le relie à une alerte (service vision)',
  })
  @Patch('sightings/:sid')
  @Access({ services: true })
  updateSighting(
    @Param('sid', new ZodPipe(zSightingId)) sid: number,
    @Body(new ZodPipe(SightingPatch)) body: z.infer<typeof SightingPatch>,
    @CurrentPrincipal() principal: Principal,
  ) {
    requireVision(principal);
    return this.persons.updateSighting(sid, body);
  }

  @ApiOperation({ summary: "Modifie le nom ou le statut d'une personne" })
  @Patch(':id')
  @Access({ role: 'admin' })
  update(
    @Param('id', new ZodPipe(zUuid)) id: string,
    @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ) {
    return this.persons.update(id, body, principal, req.ip);
  }

  @ApiOperation({ summary: 'Efface une personne et ses données (cascade)' })
  @Delete(':id')
  @Access({ role: 'admin' })
  @HttpCode(204)
  async remove(
    @Param('id', new ZodPipe(zUuid)) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ) {
    await this.persons.remove(id, principal, req.ip);
  }
}

@Module({ controllers: [PersonsController], providers: [PersonsService] })
export class PersonsModule {}
