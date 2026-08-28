import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";

type Props = {
  disabled?: boolean;
  onText: (text: string) => void;
  onError?: (msg: string) => void;
};

function pickMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export function DictateButton({ disabled, onText, onError }: Props) {
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const finish = useCallback(
    async (blob: Blob) => {
      setBusy(true);
      try {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const audioBase64 = btoa(bin);
        const resp = await fetch("/api/stt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64, mime: blob.type || "audio/webm" }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Dictation failed (${resp.status})`);
        }
        const text = String(data.text || "").trim();
        if (!text) throw new Error("No speech was detected.");
        onText(text);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Dictation failed");
      } finally {
        setBusy(false);
      }
    },
    [onError, onText],
  );

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    setListening(false);
    if (rec && rec.state !== "inactive") rec.stop();
    else stopTracks();
  }, []);

  const start = useCallback(async () => {
    if (disabled || busy || listening) return;
    setListening(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        stopTracks();
        if (blob.size > 200) void finish(blob);
        else onError?.("No speech was detected.");
      };
      recRef.current = rec;
      rec.start(200);
    } catch (e) {
      setListening(false);
      stopTracks();
      onError?.(
        e instanceof Error && /Permission|NotAllowed/i.test(e.message)
          ? "Allow microphone access for Grok Desk."
          : e instanceof Error
            ? e.message
            : "Couldn't start mic",
      );
    }
  }, [busy, disabled, finish, listening, onError]);

  const toggle = useCallback(() => {
    if (busy || disabled) return;
    if (listening) stop();
    else void start();
  }, [busy, disabled, listening, start, stop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || disabled) return;
      if (e.code === "F8" || (e.ctrlKey && !e.metaKey && e.code === "Space")) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, toggle]);

  useEffect(() => () => stop(), [stop]);

  return (
    <button
      type="button"
      className={`icon-btn sm dictate-btn${listening ? " listening" : ""}`}
      title={listening ? "Stop dictation (Ctrl+Space)" : "Dictate — same as TUI /voice (Ctrl+Space)"}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      disabled={disabled || busy}
      onClick={toggle}
    >
      <Mic size={18} strokeWidth={2} />
    </button>
  );
}
