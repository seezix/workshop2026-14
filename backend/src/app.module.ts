import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AlertsController } from './alerts/alerts.controller.js';
import { AlertsService } from './alerts/alerts.service.js';
import { AuditModule } from './audit/audit.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { CommandsService } from './commands/commands.service.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { RateLimitGuard } from './common/rate-limit.js';
import { DatabaseModule } from './db/database.module.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { HealthController } from './health/health.controller.js';
import { IngestService } from './mqtt/ingest.service.js';
import { MqttService } from './mqtt/mqtt.service.js';
import { PersonsModule } from './persons/persons.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RulesService } from './rules/rules.service.js';
import { TelemetryService } from './telemetry/telemetry.service.js';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    RealtimeModule,
    AuthModule,
    PersonsModule,
  ],
  controllers: [DevicesController, AlertsController, HealthController],
  providers: [
    MqttService,
    DevicesService,
    TelemetryService,
    AlertsService,
    CommandsService,
    RulesService,
    IngestService,
    // Ordre important : authentification, puis limite de débit par appelant.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
