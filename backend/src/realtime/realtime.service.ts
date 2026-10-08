import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

// Événements SSE (GUIDELINES §6.4).
export type RealtimeEventType =
  | 'telemetry.new'
  | 'device_event.new'
  | 'alert.created'
  | 'alert.updated'
  | 'device.status'
  | 'command.updated'
  | 'anomaly.score';

export interface RealtimeEvent {
  type: RealtimeEventType;
  data: unknown;
}

/** Bus interne : les modules publient, le contrôleur SSE diffuse. */
@Injectable()
export class RealtimeService {
  private readonly subject = new Subject<RealtimeEvent>();

  emit(type: RealtimeEventType, data: unknown): void {
    this.subject.next({ type, data });
  }

  get events$(): Observable<RealtimeEvent> {
    return this.subject.asObservable();
  }
}
