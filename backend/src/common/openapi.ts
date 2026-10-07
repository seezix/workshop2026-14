import type { INestApplication, Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { ModulesContainer, Reflector } from '@nestjs/core';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ACCESS_KEY, type AccessRule } from '../auth/access.js';
import { AUTH_COOKIE } from '../auth/auth.guard.js';
import { ZodPipe } from './zod.pipe.js';

type Operation = NonNullable<OpenAPIObject['paths'][string]['get']>;
type JsonSchema = Record<string, any>;

interface RouteArg {
  data?: string;
  pipes: unknown[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ERROR_REF = { $ref: '#/components/schemas/Error' };

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ERROR_REF } },
});

/** Schéma zod (côté entrée, avant transform) → JSON Schema OpenAPI 3.0. */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'openapi-3.0',
    unrepresentable: 'any',
  }) as JsonSchema;
  return json;
}

/** Schéma zod du premier ZodPipe posé sur les paramètres d'un type donné. */
function zodArgs(
  controller: Type,
  method: string,
  paramtype: RouteParamtypes,
): { name?: string; schema: JsonSchema }[] {
  const args: Record<string, RouteArg> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {};
  return Object.entries(args)
    .filter(([key]) => key.startsWith(`${paramtype}:`))
    .flatMap(([, arg]) => {
      const pipe = arg.pipes.find((p) => p instanceof ZodPipe);
      return pipe
        ? [{ name: arg.data, schema: toJsonSchema(pipe.schema) }]
        : [];
    });
}

/**
 * Complète une opération à partir de ce que le code applique réellement :
 * schémas des ZodPipe (corps, query, paramètres de chemin) et règle @Access.
 */
function describe(
  op: Operation,
  controller: Type,
  method: string,
  rule: AccessRule,
) {
  const [body] = zodArgs(controller, method, RouteParamtypes.BODY);
  const [query] = zodArgs(controller, method, RouteParamtypes.QUERY);
  const params = zodArgs(controller, method, RouteParamtypes.PARAM);

  op.parameters = (op.parameters ?? []).filter(
    (p) => !('in' in p && p.in === 'query'),
  );
  for (const p of op.parameters) {
    const zod = 'name' in p && params.find((a) => a.name === p.name);
    if (zod) p.schema = zod.schema;
  }
  for (const [name, schema] of Object.entries<JsonSchema>(
    query?.schema.properties ?? {},
  )) {
    op.parameters.push({
      name,
      in: 'query',
      required: query.schema.required?.includes(name) ?? false,
      schema,
    });
  }
  if (body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: body.schema } },
    };
  } else {
    delete op.requestBody;
  }

  const access: string[] = [];
  op.security = [];
  if (!rule.public) {
    if (rule.role) {
      op.security.push({ bearer: [] }, { cookie: [] });
      access.push(`rôle \`${rule.role}\` minimum`);
    }
    if (rule.services) {
      op.security.push({ 'api-key': [] });
      access.push('services internes (`X-Api-Key`)');
    }
    op.responses['401'] = errorResponse('Non authentifié');
    op.responses['403'] = errorResponse('Droits insuffisants');
  }
  if (body || query || params.length)
    op.responses['400'] = errorResponse('Requête invalide');
  op.description = [
    op.description,
    `**Accès :** ${rule.public ? 'public' : access.join(' ou ')}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Swagger UI sur /api/docs, document brut sur /api/docs-json. */
export function setupOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Sentinel-X API')
    .setDescription(
      'API du backend Sentinel-X. Se connecter avec `POST /auth/login`, puis ' +
        'coller `access_token` dans « Authorize » (le cookie httpOnly posé par ' +
        'le login suffit aussi depuis cette page).',
    )
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addCookieAuth(AUTH_COOKIE)
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controller, method) => `${controller}.${method}`,
  });
  document.components ??= {};
  document.components.schemas = {
    ...document.components.schemas,
    Error: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'VALIDATION_ERROR' },
            message: { type: 'string' },
            details: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  };

  const controllers = new Map<string, Type>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const { metatype } of module.controllers.values()) {
      if (typeof metatype === 'function')
        controllers.set(metatype.name, metatype as Type);
    }
  }
  const reflector = app.get(Reflector);

  for (const [path, item] of Object.entries(document.paths)) {
    for (const verb of HTTP_METHODS) {
      const op = item[verb];
      if (!op?.operationId) continue;
      const [controllerName, method] = op.operationId.split('.');
      const controller = controllers.get(controllerName);
      if (!controller) continue;
      // Même résolution que AuthGuard : méthode, puis classe, sinon viewer.
      const rule = reflector.getAllAndOverride<AccessRule | undefined>(
        ACCESS_KEY,
        [controller.prototype[method], controller],
      ) ?? { role: 'viewer' };
      describe(op, controller, method, rule);
      op.tags = [path.replace(/^\/api\/v1\//, '').split('/')[0]];
    }
  }

  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Sentinel-X API',
    swaggerOptions: { persistAuthorization: true },
  });
}
