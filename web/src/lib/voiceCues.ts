/**
 * Voice cues — same three MP3s as noknok copilot (start / stop / thinking).
 * Served from /sounds/*.mp3 (public).
 */

const cueUrls = {
  start: "/sounds/grok-voice-start.mp3",
  stop: "/sounds/grok-voice-stop.mp3",
  thinking: "/sounds/grok-voice-thinking.mp3",
} as const;

type CueKind = keyof typeof cueUrls;

let cueVolume = 0.65;
const THINKING_SCALE = 0.6;
let thinkGainLive: GainNode | null = null;
let cueBusyUntil = 0;
let voiceSoundCtx: AudioContext | null = null;
let thinkStopper: (() => void) | null = null;

export function setVoiceCueVolume(v: number): void {
  cueVolume = Math.max(0, Math.min(1, v));
  const ctx = voiceSoundCtx;
  if (thinkGainLive && ctx) {
    try {
      thinkGainLive.gain.setTargetAtTime(cueVolume * THINKING_SCALE, ctx.currentTime, 0.03);
    } catch {
      /* */
    }
  }
}

export function isVoiceCueActive(): boolean {
  return Date.now() < cueBusyUntil || !!thinkStopper;
}

function getVoiceSoundCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    voiceSoundCtx = voiceSoundCtx || new Ctx();
    if (voiceSoundCtx.state === "suspended") void voiceSoundCtx.resume().catch(() => {});
    return voiceSoundCtx;
  } catch {
    return null;
  }
}

const cueBuffers: Partial<Record<CueKind, Promise<AudioBuffer | null>>> = {};
function loadCue(ctx: AudioContext, kind: CueKind): Promise<AudioBuffer | null> {
  cueBuffers[kind] ||= fetch(cueUrls[kind])
    .then((r) => r.arrayBuffer())
    .then((b) => ctx.decodeAudioData(b))
    .catch(() => {
      delete cueBuffers[kind];
      return null;
    });
  return cueBuffers[kind]!;
}

export function preloadVoiceCues(): void {
  const ctx = getVoiceSoundCtx();
  if (!ctx) return;
  (Object.keys(cueUrls) as CueKind[]).forEach((k) => void loadCue(ctx, k));
}

export function playVoiceCue(kind: "start" | "stop") {
  const ctx = getVoiceSoundCtx();
  if (!ctx) return;
  void loadCue(ctx, kind).then((buf) => {
    if (!buf) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = cueVolume;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      cueBusyUntil = Date.now() + buf.duration * 1000 + 120;
    } catch {
      /* */
    }
  });
}

export function startThinkingChime() {
  if (thinkStopper) return;
  const ctx = getVoiceSoundCtx();
  if (!ctx) return;
  let alive = true;
  let src: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  void loadCue(ctx, "thinking").then((buf) => {
    if (!buf || !alive) return;
    try {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      gain = ctx.createGain();
      gain.gain.value = cueVolume * THINKING_SCALE;
      thinkGainLive = gain;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch {
      /* */
    }
  });
  thinkStopper = () => {
    alive = false;
    if (gain && ctx) {
      try {
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      } catch {
        /* */
      }
      setTimeout(() => {
        try {
          src?.stop();
        } catch {
          /* */
        }
      }, 80);
    } else {
      try {
        src?.stop();
      } catch {
        /* */
      }
    }
    thinkGainLive = null;
    thinkStopper = null;
  };
}

export function stopThinkingChime() {
  thinkStopper?.();
}
