import {
  Controller,
  Global,
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Sse,
} from '@nestjs/common';
import pg from 'pg';
import { interval, map, merge, Observable } from 'rxjs';
import { ENV, type Env } from '../config/env.js';
import { RealtimeService } from './realtime.service.js';

@Controller('stream')
export class StreamController {
  constructor(private readonly realtime: RealtimeService) {}

  /** GET /api/v1/stream : rôle viewer (cookie httpOnly ou Bearer). */
  @Sse()
  stream(): Observable<MessageEvent> {
    const events = this.realtime.events$.pipe(
      map((e) => ({ type: e.type, data: e.data }) as MessageEvent),
    );
    // Commentaire périodique pour garder la connexion ouverte derrière nginx.
    const heartbeat = interval(25_000).pipe(
      map(() => ({ type: 'ping', data: {} }) as MessageEvent),
    );
    return merge(events, heartbeat);
  }
}

/**
 * Le service d'anomalies écrit directement dans anomaly_scores ; un trigger
 * fait NOTIFY anomaly_score et on relaie en SSE.
 */
@Injectable()
class AnomalyListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AnomalyListener');
  private client?: pg.Client;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly realtime: RealtimeService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    await this.client?.end().catch(() => undefined);
  }

  private async connect() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.env.DATABASE_URL });
    client.on('notification', (msg) => {
      if (msg.channel !== 'anomaly_score' || !msg.payload) return;
      try {
        this.realtime.emit('anomaly.score', JSON.parse(msg.payload));
      } catch {
        this.logger.warn('Notification anomaly_score illisible');
      }
    });
    client.on('error', (err) => {
      this.logger.warn(`Connexion LISTEN perdue : ${err.message}`);
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query('LISTEN anomaly_score');
      this.client = client;
    } catch (err) {
      this.logger.warn(`LISTEN impossible : ${(err as Error).message}`);
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), 5_000);
  }
}

@Global()
@Module({
  controllers: [StreamController],
  providers: [RealtimeService, AnomalyListener],
  exports: [RealtimeService],
})
export class RealtimeModule {}
