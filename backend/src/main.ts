import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { setupOpenApi } from './common/openapi.js';
import { loadEnv } from './config/env.js';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '64kb' });
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  // CORS limité à l'origine du dashboard (GUIDELINES §9).
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  if (env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production') setupOpenApi(app);
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API Sentinel-X sur :${env.PORT}/api/v1`);
}
await bootstrap();
