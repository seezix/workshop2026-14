import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import { ENV, type Env } from '../config/env.js';

export const TOPIC_PREFIX = 'sentinel/v1';

export type MqttHandler = (
  deviceId: string,
  channel: string,
  payload: Buffer,
) => void | Promise<void>;

/** Connexion persistante au broker avec le compte `backend`. */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MQTT');
  private client?: MqttClient;
  private readonly handlers: MqttHandler[] = [];
  private readonly connectListeners: (() => void)[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  onModuleInit() {
    if (!this.env.MQTT_ENABLED) {
      this.logger.warn('MQTT désactivé (MQTT_ENABLED=false)');
      return;
    }
    if (
      !this.env.MQTT_URL.startsWith('mqtts://') &&
      this.env.NODE_ENV === 'production'
    ) {
      throw new Error(
        'MQTT_URL doit utiliser mqtts:// en production (pas de port en clair)',
      );
    }
    const options: IClientOptions = {
      username: this.env.MQTT_USERNAME,
      password: this.env.MQTT_PASSWORD,
      clientId: `sx-backend-${process.pid}`,
      clean: true,
      reconnectPeriod: 3_000,
      rejectUnauthorized: this.env.MQTT_REJECT_UNAUTHORIZED,
      ca: this.env.MQTT_CA_FILE
        ? readFileSync(this.env.MQTT_CA_FILE)
        : undefined,
    };
    this.client = mqtt.connect(this.env.MQTT_URL, options);

    this.client.on('connect', () => {
      this.logger.log(`Connecté à ${this.env.MQTT_URL}`);
      const topics = ['telemetry', 'events', 'status', 'cmd/ack'].map(
        (c) => `${TOPIC_PREFIX}/+/${c}`,
      );
      this.client!.subscribe(topics, { qos: 1 }, (err) => {
        if (err) this.logger.error(`Abonnement impossible : ${err.message}`);
      });
      for (const listener of this.connectListeners) listener();
    });
    this.client.on('error', (err) =>
      this.logger.warn(`Erreur : ${err.message}`),
    );
    this.client.on('offline', () => this.logger.warn('Broker injoignable'));
    this.client.on('message', (topic, payload) =>
      this.dispatch(topic, payload),
    );
  }

  async onModuleDestroy() {
    await this.client?.endAsync();
  }

  get enabled(): boolean {
    return this.env.MQTT_ENABLED;
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  onMessage(handler: MqttHandler) {
    this.handlers.push(handler);
  }

  onConnect(listener: () => void) {
    this.connectListeners.push(listener);
  }

  /** Action ponctuelle : QoS 1, jamais retained (ne doit pas se rejouer). */
  async publishCommand(deviceId: string, payload: object) {
    await this.publish(`${TOPIC_PREFIX}/${deviceId}/cmd`, payload, false);
  }

  /** État durable : QoS 1, retained, renvoyé par Mosquitto à chaque reconnexion. */
  async publishConfig(
    deviceId: string,
    config: { interval_s: number; armed: boolean },
  ) {
    await this.publish(`${TOPIC_PREFIX}/${deviceId}/config`, config, true);
  }

  private async publish(topic: string, payload: object, retain: boolean) {
    if (!this.client?.connected) throw new Error('Broker MQTT non connecté');
    await this.client.publishAsync(topic, JSON.stringify(payload), {
      qos: 1,
      retain,
    });
  }

  private dispatch(topic: string, payload: Buffer) {
    // sentinel/v1/{device_id}/{channel}
    const parts = topic.split('/');
    if (parts.length < 4 || `${parts[0]}/${parts[1]}` !== TOPIC_PREFIX) return;
    const deviceId = parts[2];
    const channel = parts.slice(3).join('/');
    for (const handler of this.handlers) {
      Promise.resolve(handler(deviceId, channel, payload)).catch((err: Error) =>
        this.logger.error(`Traitement ${topic} : ${err.message}`),
      );
    }
  }
}
