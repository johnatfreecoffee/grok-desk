/**
 * GrokVoiceSession — browser client for the xAI Grok realtime voice agent.
 *
 * Flow: mint an ephemeral token from /api/ai/voice-token → open a WebSocket
 * to wss://api.x.ai/v1/realtime (token as `xai-client-secret.<token>`
 * subprotocol) → session.update with the shared CRM tools + voice prompt →
 * stream mic PCM16@24k up, play PCM16@24k down, surface both-sides live
 * transcripts, and bridge function calls to /api/ai/tool-exec.
 *
 * Framework-agnostic: the UI passes callbacks and a tool executor. Verified
 * connection format against the live xAI endpoint (session.created on open).
 */

const XAI_WS_BASE = "wss://api.x.ai/v1/realtime";
const SAMPLE_RATE = 24000;

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

export interface VoiceCallbacks {
  onStatus: (s: VoiceStatus) => void;
  /** Live mic input level (RMS 0..~0.5), throttled to ~12/s. Drives the
   *  "it hears me" meter in the voice controls. 0 while muted. */
  onLevel?: (rms: number) => void;
  /** Grok's PLAYBACK level (RMS, ~12/s) while his audio is actually coming
   *  out of the speaker — drives the violet "Grok is talking" waveform.
   *  Emits 0 when playback drains or is flushed. */
  onOutputLevel?: (rms: number) => void;
  /** Cumulative user transcript for the in-progress utterance. */
  onUserTranscript: (text: string, final: boolean) => void;
  /** Streaming assistant transcript (what it's saying). */
  onAssistantTranscript: (text: string, final: boolean) => void;
  /** A NEW model response began — the next assistant transcript belongs to a
   *  fresh bubble (fixes two responses merging into one garbled line). */
  onAssistantTurnStart?: () => void;
  /** transient=true means the live realtime session raised it but the call is
   *  still healthy (server error event) — the UI may auto-clear it once Grok
   *  responds normally. Fatal setup errors (no key, mic, socket) omit it. */
  onError: (message: string, code?: string, transient?: boolean) => void;
  /**
   * Execute a tool the model called. Return the tool result object (the same
   * shape /api/ai/tool-exec returns under `result`), which is fed back to the
   * model. May surface a confirm card / client action in the UI as a side
   * effect before resolving.
   */
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Is app audio OUTSIDE this session audible right now (the chat cues,
   *  incl. the looping thinking chime)? The echo guard protects those windows
   *  too — on a speaker they trip server VAD exactly like Grok's own voice. */
  isExternalAudioActive?: () => boolean;
}

/** The token + session config the WS handshake needs. Returned either by the
 *  default /api/ai/voice-token fetch (CRM) or by a caller-supplied
 *  `fetchConfig` (the public site chat mints from the platform key instead). */
export interface VoiceConfig {
  token?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  tools?: unknown[];
}
export interface VoiceConfigResult {
  ok: boolean;
  /** User-facing message when ok is false. */
  error?: string;
  /** Optional error code for the UI (e.g. "no_xai_key"). */
  errorCode?: string;
  cfg: VoiceConfig;
}

export interface VoiceStartOpts {
  getAuthHeaders: () => Promise<Record<string, string>>;
  businessId?: string | null;
  /** Override the token/config source. When supplied, this is called INSTEAD
   *  of the default /api/ai/voice-token POST — it lets a non-CRM surface (the
   *  public site chat) mint a realtime token from the PLATFORM key with its
   *  own prompt + safe tool set and NO CRM scope. Return `ok:false` with an
   *  error to abort the call cleanly. */
  fetchConfig?: () => Promise<VoiceConfigResult>;
  /** The acting user for the target business (honors "Login As" impersonation)
   *  so the voice prompt + record scope resolve to THEM, not the developer. */
  actingUserId?: string | null;
  /** Recent conversation (text turns) so a voice session mid-thread picks up
   *  where the chat left off instead of starting cold. */
  contextText?: string | null;
  /** Fresh conversation: Grok speaks FIRST with one short casual opener
   *  ("Hey — what are we tackling today?") as soon as the mic is live. */
  greet?: boolean;
  /** Record-scoped voice (the Grok tab on a detail screen): pins the whole
   *  session to this record so voice-token bakes a RECORD FOCUS block into the
   *  realtime instructions. */
  recordType?: string | null;
  recordId?: string | null;
}

// Float32 [-1,1] → 16-bit PCM little-endian.
function floatToPCM16(float32: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(float32.length * 2));
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    out.setInt16(i * 2, s, true);
  }
  return out.buffer;
}

// base64 encode an ArrayBuffer in chunks (avoids call-stack blowups).
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(len / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
  return samples;
}

// Inline AudioWorklet that forwards captured mic frames to the main thread.
const CAPTURE_WORKLET = `
class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
`;

export class GrokVoiceSession {
  private ws: WebSocket | null = null;
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private playCtx: AudioContext | null = null;
  private playHead = 0; // scheduled-audio cursor (seconds)
  private muted = false;
  // Output meter: playback routes through one AnalyserNode so the voice
  // button's bars can ride Grok's ACTUAL speaker output, not protocol events.
  private playAnalyser: AnalyserNode | null = null;
  private outMeter: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  // Barge-in: every scheduled chunk is tracked so the moment the user starts
  // talking we can silence Grok mid-sentence (stop nodes + drop late deltas).
  private activeSources = new Set<AudioBufferSourceNode>();
  private suppressAudio = false;
  private responding = false;
  private greetOnReady = false;
  private lastLevelAt = 0;
  // ── Turn-accurate status tracking ──
  // The protocol's response.done fires when GENERATION ends — long before the
  // scheduled PCM finishes playing — so status is derived from what's actually
  // happening: audio still scheduled = speaking; tools running or a response
  // owed = thinking; otherwise listening. Never trust a single event alone.
  private lastStatus: VoiceStatus | null = null;
  private userSpeaking = false;
  private pendingTools = 0; // tool executions in flight
  private toolCallsSeen = 0; // function calls observed since the last continue
  private continueQueued = false; // continuation response.create already sent
  private expectingResponse = false; // response.create sent, response.created not yet back
  private expectTimer: ReturnType<typeof setTimeout> | null = null;
  private bargedIn = false; // user interrupted — let THEIR next turn drive the reply
  // Greeting gate: from the greet response.create until the user first speaks,
  // no tool-driven continuation may fire — the opener is ONE line, period.
  private greetGate = false;
  // One response.cancel per response, max — barge-in + interrupt() can both
  // fire for the same response, and a duplicate cancel earns a server error.
  private cancelRequested = false;
  // Client event ids: every outbound event carries one so a server `error`
  // event can be traced back to the exact client event that caused it.
  private evtSeq = 0;
  // Greeting self-healing: if the server rejects the greet response.create
  // (per-response override quirk / a colliding auto-response), retry ONCE as
  // a plain create — the OPENING rule in the session instructions still
  // guarantees the one-liner.
  private greetEventId: string | null = null;
  private greetRetried = false;
  private retryGreetOnDone = false;

  /** Flag that a response SHOULD be coming, with a watchdog so a commit that
   *  never yields one (noise-only VAD turn, dropped create) can't wedge the
   *  UI on "thinking" forever. */
  private expectResponse(): void {
    this.expectingResponse = true;
    if (this.expectTimer) clearTimeout(this.expectTimer);
    this.expectTimer = setTimeout(() => {
      this.expectingResponse = false;
      this.resolveStatus();
    }, 10000);
  }
  // Playback speed (client-side rate on the scheduled buffers — xAI's
  // realtime session has no speech-speed parameter; probed 2026-07-02,
  // unknown fields are silently ignored). Mild pitch shift is the tradeoff.
  private speed = 1;
  // Playback volume (master GainNode on the output chain, live-settable).
  // Lowering it also shrinks the echo energy the mic picks back up.
  private volume = 1;
  private playGain: GainNode | null = null;
  // ── Echo guard ──
  // Chrome's AEC does NOT reliably cancel local AudioContext playback, so on
  // a speaker Grok hears himself: server VAD fires, barge-in cuts him off
  // mid-sentence, and phantom "user" turns appear (John's 2026-07-09 session).
  // While Grok/cues are audible (plus a short reverb tail), quiet frames are
  // replaced with SILENCE before they reach the server — the stream cadence
  // is preserved so VAD timing stays sane, but the echo never trips it. Loud,
  // real speech still passes instantly, so voice barge-in keeps working.
  private echoGuard: "off" | "balanced" | "strong" = "balanced";
  private noiseFloor = 0.008; // slow EMA of ambient mic RMS
  private fastRms = 0; // fast EMA (~3 frames) — per-frame RMS is too jittery
  private gateOpenUntil = 0; // hangover: once speech passes, stay open
  private protectTailUntil = 0; // covers reverb/echo tail after playback drains
  private silentFrames = new Map<number, string>(); // frame length → base64 zeros
  private cb: VoiceCallbacks;

  /** Speech threshold, relative to the learned ambient floor. Post-AEC echo
   *  residue sits near the floor; real speech at the mic runs several × it. */
  private gateThreshold(): number {
    const strong = this.echoGuard === "strong";
    return Math.min(0.25, Math.max(strong ? 0.03 : 0.015, (strong ? 7 : 4) * this.noiseFloor));
  }

  /** Cached base64 of an all-zero PCM16 frame of the given length. */
  private silentFrame(len: number): string {
    let s = this.silentFrames.get(len);
    if (!s) {
      s = bufToBase64(floatToPCM16(new Float32Array(len)));
      this.silentFrames.set(len, s);
    }
    return s;
  }

  /** Throttled mic-level forwarder (~12/s) so React isn't re-rendered per audio frame. */
  private emitLevel(rms: number): void {
    const now = Date.now();
    if (now - this.lastLevelAt < 80) return;
    this.lastLevelAt = now;
    this.cb.onLevel?.(rms);
  }

  /** Deduped status emit — resolveStatus fires on many events; only real transitions reach React. */
  private setStatus(s: VoiceStatus): void {
    if (s === this.lastStatus) return;
    this.lastStatus = s;
    this.cb.onStatus(s);
  }

  /** Derive the truthful state from what's ACTUALLY happening right now. */
  private resolveStatus(): void {
    if (this.stopped) return;
    if (this.userSpeaking) { this.setStatus("listening"); return; }
    if (this.activeSources.size > 0 && !this.suppressAudio) { this.setStatus("speaking"); return; }
    // The greeting turn never shows "thinking" (which would loop the thinking
    // chime before Grok has said a single word) — it goes listening → speaking.
    if ((this.responding || this.pendingTools > 0 || this.expectingResponse) && !this.greetGate) { this.setStatus("thinking"); return; }
    this.setStatus("listening");
  }

  /** All of a turn's tool outputs are in → ask for ONE continuation response.
   *  (The old per-output response.create queued a response PER TOOL, so a
   *  two-tool turn spoke two near-identical wrap-ups back to back.) */
  private maybeContinue(): void {
    if (this.responding || this.pendingTools > 0 || this.toolCallsSeen === 0 || this.continueQueued) return;
    this.toolCallsSeen = 0;
    // The user barged in mid-run: their next utterance drives the reply — a
    // forced continuation here would talk over them.
    if (this.bargedIn) return;
    // Greeting turn: even if the model snuck a tool call into the opener, the
    // results wait silently — the user speaks next, not Grok.
    if (this.greetGate) return;
    this.continueQueued = true;
    this.expectResponse();
    this.send({ type: "response.create" });
  }

  constructor(cb: VoiceCallbacks) {
    this.cb = cb;
  }

  async start(opts: VoiceStartOpts): Promise<void> {
    this.setStatus("connecting");
    // 1) Mint ephemeral token + fetch tools/instructions. A caller can override
    //    the source (the public site chat mints from the platform key); the
    //    default hits the CRM's /api/ai/voice-token with the business scope.
    let cfg: VoiceConfig;
    if (opts.fetchConfig) {
      const r = await opts.fetchConfig();
      if (!r.ok) {
        this.cb.onError(r.error || "Couldn't start voice.", r.errorCode);
        this.setStatus("error");
        return;
      }
      cfg = r.cfg || {};
    } else {
      const headers = await opts.getAuthHeaders();
      const resp = await fetch("/api/ai/voice-token", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          business_id: opts.businessId ?? null,
          acting_user_id: opts.actingUserId ?? null,
          // Device timezone → "today" in the voice prompt is the USER'S today.
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          // Record scope (the Grok tab) → RECORD FOCUS baked into instructions.
          record_type: opts.recordType ?? null,
          record_id: opts.recordId ?? null,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = body.no_xai_key
          ? "Voice needs an xAI key. Add one in Settings → AI Keys."
          : body.error || "Couldn't start voice.";
        this.cb.onError(msg, body.no_xai_key ? "no_xai_key" : body.bad_xai_key ? "bad_xai_key" : undefined);
        this.setStatus("error");
        return;
      }
      cfg = body;
    }

    // 2) Open the realtime socket (token as subprotocol).
    const url = `${XAI_WS_BASE}?model=${encodeURIComponent(cfg.model || "grok-voice-latest")}`;
    const ws = new WebSocket(url, [`xai-client-secret.${cfg.token}`]);
    this.ws = ws;

    // Mid-thread voice continues the conversation — feed the recent text
    // turns into the session instructions so Grok knows what came before.
    let instructions = opts.contextText
      ? `${cfg.instructions || ""}\n\nCONVERSATION SO FAR (you are CONTINUING this conversation — don't re-greet, don't repeat answered questions):\n${opts.contextText}`
      : cfg.instructions || "";
    if (opts.greet && !opts.contextText) {
      this.greetOnReady = true;
      instructions += "\n\nOPENING (HARD RULE): this is a brand-new conversation and YOU speak first. Open with exactly ONE short, casual greeting — like \"Hey — what are we tackling today?\", \"Hey, what's going on?\", or \"Hey, how can I help?\" (vary it, don't always use the same one). ONE sentence, then STOP and listen. Do NOT call any tool, do NOT pull the home snapshot, do NOT report overdue items, missed calls, or a briefing, and do NOT add a second sentence — nothing else happens until the user speaks first.";
    }

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice: cfg.voice || "Rex", // "Rex" = xAI voice id (not the assistant name)
            instructions,
            modalities: ["audio", "text"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad" },
            tools: cfg.tools || [],
            tool_choice: "auto",
          },
        }),
      );
    };

    ws.onmessage = (ev) => this.handleEvent(ev.data);
    ws.onerror = () => { if (!this.stopped) { this.cb.onError("Voice connection error."); this.setStatus("error"); } };
    ws.onclose = () => { if (!this.stopped) this.setStatus("ended"); };
  }

  private async startMic(): Promise<void> {
    // Two attempts: the cached stream first, and if wiring it up fails in ANY
    // way (a restarted session on some platforms gets a dead/muted cached
    // track), drop the cache and retry once with a brand-new getUserMedia.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) releaseMicStream();
        this.micStream = await acquireMicStream();
        this.micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (this.micCtx.state === "suspended") await this.micCtx.resume().catch(() => {});
        const blobUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
        await this.micCtx.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);
        const src = this.micCtx.createMediaStreamSource(this.micStream);
        this.workletNode = new AudioWorkletNode(this.micCtx, "pcm-capture");
        this.workletNode.port.onmessage = (e) => {
          if (this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (this.muted) this.emitLevel(0);
            return;
          }
          const float = e.data as Float32Array;
          let sum = 0;
          for (let i = 0; i < float.length; i++) sum += float[i] * float[i];
          const rms = Math.sqrt(sum / float.length);
          this.emitLevel(rms); // meter always shows the REAL mic, gated or not
          this.fastRms = this.fastRms * 0.6 + rms * 0.4; // ~15ms attack
          // Echo guard: while Grok/cues are audible (or just drained), only
          // frames that clear the speech threshold — or ride its hangover —
          // go up as real audio; the rest go up as silence.
          const protecting = this.echoGuard !== "off" &&
            (this.activeSources.size > 0 || performance.now() < this.protectTailUntil || this.cb.isExternalAudioActive?.() === true);
          const threshold = this.gateThreshold();
          if (!protecting || rms < threshold) {
            // Learn the ambient floor from idle/sub-threshold frames only —
            // never from the user's own speech.
            this.noiseFloor = Math.min(0.05, Math.max(0.002, this.noiseFloor * 0.98 + rms * 0.02));
          }
          let audio: string;
          if (protecting && this.fastRms < threshold && performance.now() >= this.gateOpenUntil) {
            audio = this.silentFrame(float.length);
          } else {
            if (protecting) this.gateOpenUntil = performance.now() + 300; // don't chop mid-word
            audio = bufToBase64(floatToPCM16(float));
          }
          this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        };
        src.connect(this.workletNode);
        // Worklet needs a sink to pump; route to a muted gain so nothing plays.
        const sink = this.micCtx.createGain();
        sink.gain.value = 0;
        this.workletNode.connect(sink).connect(this.micCtx.destination);
        // Ended while we were awaiting mic permission → don't go "listening",
        // don't play the connect cue, and never fire the greeting create.
        if (this.stopped) { try { this.micCtx.close(); } catch { /* noop */ } this.micCtx = null; return; }
        this.setStatus("listening");
        // Fresh conversation → Grok opens with a short greeting. The response
        // is SCOPED: tool_choice none + greeting-only instructions, so the
        // opener can never become an unprompted briefing (observed 2026-07-09:
        // three spoken lines + a home-snapshot rundown before the user said a
        // word). greetGate additionally suppresses the tool continuation until
        // the user actually speaks, even if the model calls a tool anyway.
        if (this.greetOnReady) {
          this.greetOnReady = false;
          this.greetGate = true;
          // Deliberately NO expectResponse() here: it would flip status to
          // "thinking" and start the thinking chime before Grok has spoken a
          // word. greetGate holds status on "listening" until audio arrives.
          this.greetEventId = this.send({
            type: "response.create",
            response: {
              tool_choice: "none",
              instructions: "Say EXACTLY one short, casual greeting — like \"Hey, what's going on?\" — and NOTHING else. No tools, no data, no rundown, no second sentence. Then wait silently for the user.",
            },
          });
          this.resolveStatus();
        }
        return;
      } catch (e) {
        try { this.micCtx?.close(); } catch { /* noop */ }
        this.micCtx = null;
        if (attempt === 0) continue; // retry fresh
        this.cb.onError("Microphone access denied or unavailable.");
        this.setStatus("error");
      }
    }
  }

  private playChunk(b64: string): void {
    if (this.stopped || this.suppressAudio) return; // ended, or user barged in — never (re)create the play context or schedule audio
    if (!this.playCtx) this.playCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const ctx = this.playCtx;
    const float = base64ToFloat32(b64);
    if (!float.length) return;
    const buffer = ctx.createBuffer(1, float.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = this.speed;
    if (!this.playGain) {
      // sources → gain (user volume) → analyser → destination. The analyser
      // sits POST-gain so the violet bars track what the speaker actually emits.
      this.playGain = ctx.createGain();
      this.playGain.gain.value = this.volume;
      this.playAnalyser = ctx.createAnalyser();
      this.playAnalyser.fftSize = 256;
      this.playGain.connect(this.playAnalyser);
      this.playAnalyser.connect(ctx.destination);
    }
    node.connect(this.playGain);
    this.startOutMeter();
    const now = ctx.currentTime;
    if (this.playHead < now) this.playHead = now;
    node.start(this.playHead);
    this.playHead += buffer.duration / this.speed;
    this.activeSources.add(node);
    // Playback drain drives the speaking→(thinking|listening) transition: the
    // protocol says the response is "done" while seconds of PCM are still
    // scheduled, so the UI trusts the speaker, not the server.
    node.onended = () => {
      this.activeSources.delete(node);
      if (this.activeSources.size === 0) {
        this.protectTailUntil = performance.now() + 300; // echo tail cover
        this.resolveStatus();
      }
    };
    this.resolveStatus(); // audio scheduled → speaking
  }

  /** ~12/s RMS of what's actually playing → onOutputLevel. Self-stops (and
   *  zeroes the level) once the scheduled audio drains or gets flushed. */
  private startOutMeter(): void {
    if (this.outMeter || !this.cb.onOutputLevel || !this.playAnalyser) return;
    const data = new Float32Array(this.playAnalyser.fftSize);
    this.outMeter = setInterval(() => {
      if (!this.playAnalyser || this.activeSources.size === 0 || this.suppressAudio) { this.stopOutMeter(); return; }
      this.playAnalyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      this.cb.onOutputLevel?.(Math.sqrt(sum / data.length));
    }, 80);
  }
  private stopOutMeter(): void {
    if (this.outMeter) { clearInterval(this.outMeter); this.outMeter = null; }
    this.cb.onOutputLevel?.(0);
  }

  /** Silence Grok immediately: stop every scheduled audio buffer and reset the cursor. */
  private flushPlayback(): void {
    this.stopOutMeter();
    for (const node of this.activeSources) {
      try { node.onended = null; node.stop(); } catch { /* already ended */ }
    }
    if (this.activeSources.size > 0) this.protectTailUntil = performance.now() + 300;
    this.activeSources.clear();
    this.playHead = 0;
  }

  /** Cut Grok off RIGHT NOW (user tapped Confirm / took an action mid-
   *  sentence): stop the scheduled audio, drop the rest of the in-flight
   *  response, cancel generation. The next response.create speaks fresh. */
  interrupt(): void {
    this.flushPlayback();
    this.suppressAudio = true;
    this.bargedIn = true; // pending tool runs must not force a wrap-up over the user's action
    this.requestCancel();
    this.resolveStatus();
  }

  /** Cancel the in-flight response, once. A cancel that loses the race with
   *  response.done just earns a benign server error (filtered in handleEvent). */
  private requestCancel(): void {
    if (!this.responding || this.cancelRequested) return;
    this.cancelRequested = true;
    this.send({ type: "response.cancel" });
  }

  /** Inject a typed/user-action message into the live conversation (e.g. a
   *  tapped Confirm) and ask the model to respond to it. */
  sendUserText(text: string): void {
    this.greetGate = false; // the user is engaging — normal turn-taking resumes
    this.flushTapNotes();
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.bargedIn = false;
    this.expectResponse();
    this.send({ type: "response.create" });
    this.resolveStatus();
  }

  /** After an action commits, keep the conversation MOVING: ask for exactly
   *  one short scoped follow-up line ("Sent — now, that Saturday task?")
   *  instead of dropping to silence. No-op while the user is mid-utterance —
   *  their turn drives the reply then. */
  requestFollowUp(instruction: string): void {
    if (this.userSpeaking) return;
    this.bargedIn = false;
    this.greetGate = false;
    this.expectResponse();
    this.send({ type: "response.create", response: { instructions: instruction } });
    this.resolveStatus();
  }

  /** Re-arm the natural post-tool continuation after an interrupt() — used
   *  when a tool's side effect (e.g. CRM send) cut playback but the turn's
   *  single wrap-up response should still happen. */
  allowContinue(): void {
    this.bargedIn = false;
    this.maybeContinue();
  }

  /** Silently add context the model should know (e.g. "the text was sent")
   *  WITHOUT asking it to speak — callers that want a spoken follow-up pair
   *  this with requestFollowUp()/allowContinue(). The model sees this item
   *  on its next turn. Returns the queued note text so the caller can later
   *  upgrade it via replaceTapNote(). */
  notifyContext(text: string): string {
    const clean = text.replace(/^\[|\]$/g, "");
    this.sendTrackedItem(text, [clean]);
    // A floating mid-silence item is easy for the model to lose track of
    // (observed 2026-07-09: user tapped three Confirms, then asked "did they
    // go out?" and Grok insisted they were still pending). Keep the note and
    // re-assert it ONCE, directly adjacent to the user's next utterance.
    this.tapNotes.push(clean);
    return clean;
  }

  /** Upgrade a pre-commit note ("committing RIGHT NOW") to its definitive
   *  post-commit wording — success or a CORRECTION on failure. The stale
   *  queued copy is dropped so the next flush re-asserts only the truth. */
  replaceTapNote(preNote: string | null | undefined, finalText: string): void {
    if (preNote) this.tapNotes = this.tapNotes.filter((t) => t !== preNote);
    this.notifyContext(finalText);
  }

  private tapNotes: string[] = []; // tap-commits not yet re-asserted next to a user turn

  /** Flush accumulated tap-commit notes as ONE consolidated item so it lands
   *  immediately before the user's next message in the conversation. */
  private flushTapNotes(): void {
    if (this.tapNotes.length === 0) return;
    const snapshot = this.tapNotes;
    this.tapNotes = [];
    const text = `[GROUND TRUTH from my on-screen taps — trust these over your own tool memory, do not redo or re-verify them: ${snapshot.join(" ")}]`;
    this.sendTrackedItem(text, snapshot);
  }

  // ── Tap-note delivery tracking ──
  // Each note item carries a client-set id which the server echoes back in
  // conversation.item.added (verified against live xAI 2026-07-09). A note
  // that never made it — socket not open, or the server rejected the create —
  // goes back on the queue so the next flush re-asserts it. Before this, a
  // lost note simply vanished and Grok kept claiming the write was pending.
  private pendingNotes = new Map<string, { itemId: string; texts: string[]; timer: ReturnType<typeof setTimeout> }>();
  private noteSeq = 0;

  private sendTrackedItem(text: string, texts: string[]): void {
    const itemId = `item_note_${++this.noteSeq}_${Date.now().toString(36)}`;
    const eventId = this.send({
      type: "conversation.item.create",
      item: { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    if (!eventId) { this.restoreNotes(texts); return; } // silent socket drop — detected now
    // No ack and no error within 4s → assume delivered (keeps the map bounded
    // even if the server never echoes items).
    const timer = setTimeout(() => this.pendingNotes.delete(eventId), 4000);
    this.pendingNotes.set(eventId, { itemId, texts, timer });
  }

  private restoreNotes(texts: string[]): void {
    for (const t of texts) if (!this.tapNotes.includes(t)) this.tapNotes.unshift(t);
  }

  private async handleEvent(data: unknown): Promise<void> {
    // Once the user hits End, the session is DEAD to us: the socket is closing
    // but the server has already sent (or is mid-stream of) the greeting/response
    // audio. Ignoring every late event here is what stops Grok speaking AFTER
    // End — otherwise a straggling response.audio.delta reaches playChunk and
    // plays the whole reply on a freshly-created AudioContext (John 2026-07-10:
    // "click End real fast… it still gives me the voice response").
    if (this.stopped) return;
    if (typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    const type = msg.type as string;

    switch (type) {
      case "session.created":
        // Session is live — now grab the mic and start streaming.
        await this.startMic();
        break;
      case "session.updated":
        break;

      // The server echoes created items (with our client-set id) — that's the
      // delivery receipt for tracked tap notes. xAI emits "added"; "created"
      // kept for OpenAI-dialect compatibility.
      case "conversation.item.added":
      case "conversation.item.created": {
        const itemId = String((msg.item as { id?: string } | undefined)?.id ?? "");
        if (itemId.startsWith("item_note_")) {
          for (const [key, entry] of this.pendingNotes) {
            if (entry.itemId === itemId) { clearTimeout(entry.timer); this.pendingNotes.delete(key); break; }
          }
        }
        break;
      }

      // User speech transcription (cumulative).
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.updated":
        this.cb.onUserTranscript(String((msg.transcript as string) ?? (msg.delta as string) ?? ""), false);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.cb.onUserTranscript(String((msg.transcript as string) ?? ""), true);
        break;

      // Assistant spoken-text transcript (streaming).
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.cb.onAssistantTranscript(String((msg.delta as string) ?? ""), false);
        break;
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        this.cb.onAssistantTranscript(String((msg.transcript as string) ?? ""), true);
        break;

      // Assistant audio.
      case "response.audio.delta":
      case "response.output_audio.delta":
        this.playChunk(String((msg.delta as string) ?? (msg.audio as string) ?? ""));
        break;

      case "input_audio_buffer.speech_started":
        // BARGE-IN: the user started talking. If Grok is mid-answer, shut him
        // up NOW — stop the scheduled audio, drop any late deltas from the
        // canceled response, and tell the server to stop generating.
        this.userSpeaking = true;
        this.greetGate = false; // the user is engaging — normal turn-taking resumes
        if (this.responding || this.activeSources.size > 0) {
          this.flushPlayback();
          this.suppressAudio = true;
          this.bargedIn = true;
          this.requestCancel();
        }
        // The user is talking again after tapping Confirm card(s): land the
        // consolidated "already committed" note right before their message.
        this.flushTapNotes();
        this.setStatus("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        // Server VAD closed the user's utterance — a response is coming.
        this.userSpeaking = false;
        this.expectResponse();
        this.resolveStatus();
        break;
      case "response.created":
        this.responding = true;
        this.cancelRequested = false; // fresh response — cancellable again
        this.userSpeaking = false;
        this.expectingResponse = false;
        if (this.expectTimer) { clearTimeout(this.expectTimer); this.expectTimer = null; }
        this.continueQueued = false;
        this.bargedIn = false;
        this.suppressAudio = false; // fresh response — audio welcome again
        this.cb.onAssistantTurnStart?.();
        this.resolveStatus();
        break;
      case "response.done":
      case "response.cancelled":
        this.responding = false;
        // A rejected greeting create waits out the colliding response, then
        // retries once as a plain create.
        if (this.retryGreetOnDone) {
          this.retryGreetOnDone = false;
          this.send({ type: "response.create" });
        }
        // If this response called tools, the turn isn't over — outputs go up,
        // then ONE continuation response wraps it. Status stays truthful
        // (speaking while audio drains, thinking while tools run).
        this.maybeContinue();
        this.resolveStatus();
        break;

      // Function call → execute → feed the result back. The continuation
      // response is requested ONCE per turn (maybeContinue), after the
      // response is done AND every output is in — never per tool.
      case "response.function_call_arguments.done": {
        const callId = (msg.call_id as string) || (msg.id as string);
        const name = msg.name as string;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse((msg.arguments as string) || "{}"); } catch { /* ignore */ }
        this.pendingTools += 1;
        this.toolCallsSeen += 1;
        this.resolveStatus();
        let result: unknown;
        try { result = await this.cb.onToolCall(name, args); }
        catch (e) { result = { error: e instanceof Error ? e.message : "tool failed" }; }
        this.send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result ?? {}) },
        });
        this.pendingTools -= 1;
        this.maybeContinue();
        this.resolveStatus();
        break;
      }

      case "error": {
        const err = (msg.error as Record<string, unknown>) || msg;
        const text = String((err.message as string) || "Voice error");
        // Field diagnostic: log the RAW event — John kept hitting an
        // unexplained banner on every fresh chat, and the forwarded message
        // alone doesn't say which client event the server objected to.
        console.warn("[voice] realtime error event:", data);
        // Benign cancel race: our response.cancel crossed the wire after the
        // server already finished (or auto-cancelled) that response — e.g.
        // barging in right as the greeting wraps. "Nothing to cancel" IS the
        // state we wanted, so don't scare the user with a red banner over it.
        if (/cancel/i.test(text) && /no active response/i.test(text)) break;
        const causeId = String((err.event_id as string) ?? (msg.event_id as string) ?? "");
        if (this.handleRejectedClientEvent(causeId, text)) break;
        const code = String((err.code as string) ?? (err.type as string) ?? "") || undefined;
        this.cb.onError(text, code, true /* transient: the call is still alive */);
        break;
      }
    }
  }

  /** A server error event names the client event that caused it — recover the
   *  recoverable ones silently instead of raising the red banner: the greeting
   *  create gets one plain-create retry; a rejected tap note goes back on the
   *  queue for the next flush. Returns true when consumed. */
  private handleRejectedClientEvent(causeId: string, text: string): boolean {
    if (this.greetGate && !this.greetRetried && (causeId === this.greetEventId || /active response/i.test(text))) {
      this.greetRetried = true;
      if (this.responding) this.retryGreetOnDone = true;
      else this.send({ type: "response.create" });
      return true;
    }
    const note = this.pendingNotes.get(causeId);
    if (note) {
      clearTimeout(note.timer);
      this.pendingNotes.delete(causeId);
      this.restoreNotes(note.texts);
      return true;
    }
    return false;
  }

  /** Send a client event (an event_id is attached so server errors can be
   *  traced back to it). Returns the event_id — or null when the socket isn't
   *  open, so callers that persist state can detect the silent drop. */
  private send(obj: Record<string, unknown>): string | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const event_id = typeof obj.event_id === "string" ? obj.event_id : `evt_c_${++this.evtSeq}_${Date.now().toString(36)}`;
    this.ws.send(JSON.stringify({ ...obj, event_id }));
    return event_id;
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  /** Grok's speaking speed (0.8–1.5). Applies to the next scheduled chunk. */
  setSpeed(s: number): void {
    this.speed = Math.min(Math.max(s, 0.8), 1.5);
  }

  /** Grok's playback volume (0–1), live — ramped so a mid-sentence change
   *  never clicks. Also proportionally shrinks speaker echo at the mic. */
  setVolume(v: number): void {
    this.volume = Math.min(Math.max(v, 0), 1);
    if (this.playGain && this.playCtx) {
      try { this.playGain.gain.setTargetAtTime(this.volume, this.playCtx.currentTime, 0.03); } catch { /* noop */ }
    }
  }

  /** Echo-guard aggressiveness (off / balanced / strong), live. */
  setEchoGuard(mode: "off" | "balanced" | "strong"): void {
    this.echoGuard = mode;
  }

  stop(): void {
    this.stopped = true;
    this.suppressAudio = true; // any audio delta already queued this tick bails
    // Tell the server to STOP generating before we sever the socket, so it stops
    // producing the greeting/response we're ending on (the ephemeral session
    // also tears down on ws close, but this cuts generation a beat sooner and
    // costs nothing — a "no active response" reply is filtered/ignored).
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "response.cancel" })); } catch { /* noop */ }
    for (const entry of this.pendingNotes.values()) clearTimeout(entry.timer);
    this.pendingNotes.clear();
    this.flushPlayback();
    try { this.workletNode?.disconnect(); } catch { /* noop */ }
    // Don't STOP the mic tracks — just disable them. The cached stream stays
    // grantable for the next voice session without re-prompting (esp. iOS
    // PWA, which re-asks on every fresh getUserMedia). Fully released on
    // pagehide (below).
    try { this.micStream?.getAudioTracks().forEach((t) => { t.enabled = false; }); } catch { /* noop */ }
    try { this.micCtx?.close(); } catch { /* noop */ }
    try { this.playCtx?.close(); } catch { /* noop */ }
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
    // Null the contexts so a late frame can never lazily reopen playback.
    this.playCtx = null;
    this.micCtx = null;
    this.setStatus("ended");
  }
}

// ── Session-scoped mic stream cache ──
// Ask for the mic ONCE per app run and reuse the granted stream across voice
// sessions — repeat getUserMedia calls are what re-trigger the permission
// prompt on iOS PWAs. Released for real when the page is hidden/closed so the
// OS mic indicator doesn't linger after leaving the app.
let cachedMicStream: MediaStream | null = null;

async function acquireMicStream(): Promise<MediaStream> {
  // A cached track that ended or got OS-muted is no good — treat as dead.
  const live = cachedMicStream?.getAudioTracks().some((t) => t.readyState === "live" && !t.muted);
  if (cachedMicStream && live) {
    cachedMicStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    return cachedMicStream;
  }
  cachedMicStream = await Promise.race([
    // autoGainControl OFF: AGC ramps mic gain during the user's silence —
    // which is precisely while Grok speaks — amplifying the very echo the
    // send-gate rejects. The gate's noise-floor-relative threshold covers
    // quiet talkers. (Revert this one token first if John reports weak pickup.)
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } }),
    // Race against a timeout so a dismissed/ignored permission prompt
    // surfaces an error instead of hanging on "Connecting…".
    new Promise<MediaStream>((_, rej) => setTimeout(() => rej(new Error("mic-timeout")), 20000)),
  ]);
  return cachedMicStream;
}

function releaseMicStream(): void {
  try { cachedMicStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  cachedMicStream = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", releaseMicStream);
}
