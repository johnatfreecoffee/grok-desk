/**
 * Mint a short-lived xAI realtime client secret for browser voice.
 * Only called when the user starts voice — never for text chat.
 */
import { resolveXaiApiKey } from "./secrets.js";

const XAI_CLIENT_SECRET_URL = "https://api.x.ai/v1/realtime/client_secrets";
const XAI_VOICE_MODEL = "grok-voice-latest";
const XAI_DEFAULT_VOICE = "Rex";

const DESK_VOICE_INSTRUCTIONS = `You are Grok, a sharp personal desk assistant running on the user's Mac (Grok Desk).
You are in REALTIME VOICE mode — speak naturally, keep answers tight, and prefer short spoken turns over monologues.
This is a personal local app, not a CRM. You have no tools in voice mode.
If the user wants file/code work, tell them to use the text chat (the CLI agent) for that.
Be direct, useful, and a little dry-witty. Never invent that you ran tools you didn't.`;

function extractSecret(data) {
  if (!data) return null;
  if (typeof data === "string") return data;
  return (
    data.value ||
    data.client_secret?.value ||
    data.client_secret ||
    data.secret ||
    data.token ||
    data.ephemeral_token ||
    null
  );
}

function extractExpiry(data) {
  if (!data || typeof data !== "object") return null;
  return data.expires_at || data.client_secret?.expires_at || data.expires || null;
}

export async function mintVoiceToken({ contextText } = {}) {
  const key = resolveXaiApiKey();
  if (!key) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "Add an xAI API key in Settings to use voice mode. Text chat works without it.",
        no_xai_key: true,
      },
    };
  }

  const res = await fetch(XAI_CLIENT_SECRET_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: { model: XAI_VOICE_MODEL, voice: XAI_DEFAULT_VOICE },
    }),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  if (!res.ok) {
    console.error("[voice-token] xAI error", res.status, raw.slice(0, 400));
    const lower = raw.toLowerCase();
    const badKey =
      res.status === 401 ||
      res.status === 403 ||
      lower.includes("incorrect api key") ||
      lower.includes("invalid api key") ||
      lower.includes("unauthorized");
    return {
      ok: false,
      status: badKey ? 401 : 502,
      body: {
        error: badKey
          ? "xAI API key rejected. Update it in Settings → Voice."
          : `Could not start voice (xAI ${res.status}).`,
        bad_xai_key: badKey,
      },
    };
  }

  const secret = extractSecret(data);
  if (!secret) {
    return {
      ok: false,
      status: 502,
      body: { error: "Voice service returned no token." },
    };
  }

  let instructions = DESK_VOICE_INSTRUCTIONS;
  if (contextText) {
    instructions += `\n\nCONVERSATION SO FAR (continue — don't re-greet):\n${contextText}`;
  }

  return {
    ok: true,
    status: 200,
    body: {
      token: secret,
      expires_at: extractExpiry(data),
      model: XAI_VOICE_MODEL,
      voice: XAI_DEFAULT_VOICE,
      instructions,
      tools: [],
    },
  };
}
