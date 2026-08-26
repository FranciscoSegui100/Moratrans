let audioCtx: AudioContext | null = null;

// Genera un "ping" de dos tonos con Web Audio API en vez de reproducir un
// archivo: no depende de un asset externo y no necesita descarga previa.
export function playAlertSound() {
  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const ctx = audioCtx;
    const now = ctx.currentTime;

    const playTone = (freq: number, start: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.15, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration);
    };

    playTone(880, 0, 0.15);
    playTone(1175, 0.12, 0.2);
  } catch {
    // Si el navegador bloquea el audio (sin interacción previa) no rompemos el flujo de la alerta.
  }
}
