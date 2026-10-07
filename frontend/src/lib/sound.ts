// Bip d'alerte synthétisé (pas de fichier audio). Le navigateur n'autorise le
// son qu'après une interaction : d'où le bouton « Activer les alertes sonores ».

let ctx: AudioContext | null = null

export async function unlockAudio() {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
}

export function beep(critical: boolean) {
  if (!ctx || ctx.state !== 'running') return
  const pulses = critical ? 3 : 1
  for (let i = 0; i < pulses; i++) {
    const start = ctx.currentTime + i * 0.25
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = critical ? 880 : 660
    gain.gain.setValueAtTime(0.08, start)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + 0.2)
  }
}
