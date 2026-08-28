// Sonido de alerta del panel: reproduce un archivo de frontend/public/.
// Cambiá el nombre acá si reemplazás el asset.
const ALERT_SOUND_URL = '/gemissements-250.mp3';
const ALERT_VOLUME = 0.6; // 0 = mudo, 1 = máximo

let audio: HTMLAudioElement | null = null;

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(ALERT_SOUND_URL);
    audio.preload = 'auto';
    audio.volume = ALERT_VOLUME;
  }
  return audio;
}

// Los navegadores no dejan sonar audio hasta que hubo un gesto real del
// usuario (click, tecla, touch) en la página: si el panel queda abierto de
// fondo y llega una alerta antes de que alguien toque algo, el primer
// play() queda bloqueado. Con el primer gesto -sea cual sea- "cebamos" el
// elemento (play + pause en silencio) para que después suene sin bloqueo.
function primeAudio() {
  const a = getAudio();
  const volPrevio = a.volume;
  a.volume = 0;
  a.play()
    .then(() => {
      a.pause();
      a.currentTime = 0;
      a.volume = volPrevio;
    })
    .catch(() => {
      a.volume = volPrevio;
    });
}

export function armarSonidoAlerta() {
  document.addEventListener('pointerdown', primeAudio, { once: true });
  document.addEventListener('keydown', primeAudio, { once: true });
  return () => {
    document.removeEventListener('pointerdown', primeAudio);
    document.removeEventListener('keydown', primeAudio);
  };
}

export function playAlertSound() {
  try {
    const a = getAudio();
    a.currentTime = 0; // reinicia si ya venía sonando (alertas seguidas)
    a.play().catch(() => {
      // Si el navegador bloquea el audio no rompemos el flujo de la alerta.
    });
  } catch {
    // idem
  }
}

// ---------------------------------------------------------------------------
// SONIDO ORIGINAL (ping de dos tonos con Web Audio API, sin asset externo).
// No se borra: para volver atrás, borrá el bloque de arriba (desde
// ALERT_SOUND_URL hasta acá) y descomentá este.
// ---------------------------------------------------------------------------
//
// let audioCtx: AudioContext | null = null;
//
// function getContext(): AudioContext {
//   if (!audioCtx) {
//     const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
//     audioCtx = new AudioContextClass();
//   }
//   return audioCtx;
// }
//
// function intentarDesbloquear() {
//   const ctx = getContext();
//   if (ctx.state === 'suspended') ctx.resume().catch(() => {});
// }
//
// export function armarSonidoAlerta() {
//   document.addEventListener('pointerdown', intentarDesbloquear);
//   document.addEventListener('keydown', intentarDesbloquear);
//   return () => {
//     document.removeEventListener('pointerdown', intentarDesbloquear);
//     document.removeEventListener('keydown', intentarDesbloquear);
//   };
// }
//
// export function playAlertSound() {
//   try {
//     const ctx = getContext();
//     if (ctx.state === 'suspended') ctx.resume().catch(() => {});
//
//     const now = ctx.currentTime;
//
//     const playTone = (freq: number, start: number, duration: number) => {
//       const osc = ctx.createOscillator();
//       const gain = ctx.createGain();
//       osc.type = 'sine';
//       osc.frequency.value = freq;
//       gain.gain.setValueAtTime(0, now + start);
//       gain.gain.linearRampToValueAtTime(0.15, now + start + 0.01);
//       gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
//       osc.connect(gain);
//       gain.connect(ctx.destination);
//       osc.start(now + start);
//       osc.stop(now + start + duration);
//     };
//
//     playTone(880, 0, 0.15);
//     playTone(1175, 0.12, 0.2);
//   } catch {
//     // Si el navegador bloquea el audio no rompemos el flujo de la alerta.
//   }
// }
