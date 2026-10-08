/**
 * Datation des messages de l'ESP (GUIDELINES §4, §5.4).
 *
 * L'ESP n'a pas d'heure fiable : il envoie uptime_ms, le backend date à la
 * réception. Pour les événements gardés dans le tampon hors ligne et renvoyés
 * à la reconnexion, on recalcule l'heure à partir de la dernière référence
 * « en direct » (uptime connu à un instant connu), tant que le boîtier n'a pas
 * redémarré entre-temps.
 */
export class DeviceClock {
  private readonly refs = new Map<string, { uptimeMs: number; at: number }>();

  /** Écart au-delà duquel un message est considéré comme différé. */
  static readonly LATE_THRESHOLD_MS = 2_000;

  /** Instant estimé de l'événement, en ms epoch. */
  resolve(
    deviceId: string,
    uptimeMs: number | undefined,
    receivedAt: number,
  ): number {
    if (uptimeMs === undefined) return receivedAt;
    const ref = this.refs.get(deviceId);

    if (ref && uptimeMs >= ref.uptimeMs) {
      const estimated = ref.at + (uptimeMs - ref.uptimeMs);
      if (receivedAt - estimated > DeviceClock.LATE_THRESHOLD_MS) {
        // Message différé (tampon hors ligne) : on garde l'estimation et on ne
        // déplace pas la référence.
        return estimated;
      }
    }

    // Message en direct, ou uptime revenu en arrière (redémarrage) : il
    // devient la nouvelle référence.
    this.refs.set(deviceId, { uptimeMs, at: receivedAt });
    return receivedAt;
  }

  /** À appeler sur BOOT : l'uptime repart de zéro. */
  reset(deviceId: string): void {
    this.refs.delete(deviceId);
  }
}
