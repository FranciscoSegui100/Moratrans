let audioCtx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

function intentarDesbloquear() {
  const ctx = getContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

// Los navegadores no dejan sonar audio hasta que hubo un gesto real del
// usuario (click, tecla, touch) en la página: si el panel queda abierto de
// fondo y llega una alerta antes de que alguien toque algo, el AudioContext
// queda "suspended" para siempre y playAlertSound() no suena. Enganchamos
// estos listeners apenas se monta el panel para que el primer click/tecla
// -sea cual sea- ya deje el audio listo antes de que haga falta.
export function armarSonidoAlerta() {
  document.addEventListener('pointerdown', intentarDesbloquear);
  document.addEventListener('keydown', intentarDesbloquear);
  return () => {
    document.removeEventListener('pointerdown', intentarDesbloquear);
    document.removeEventListener('keydown', intentarDesbloquear);
  };
}

// Genera un "ping" de dos tonos con Web Audio API en vez de reproducir un
// archivo: no depende de un asset externo y no necesita descarga previa.
export function playAlertSound() {
  try {
    const ctx = getContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

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
    // Si el navegador bloquea el audio no rompemos el flujo de la alerta.
  }
}
