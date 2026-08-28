import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

const MODES = [
  { id: "concise", label: "Concise" },
  { id: "casual", label: "Casual" },
  { id: "full", label: "Full" },
] as const;

const RATES = [0.75, 1, 1.25, 1.5, 2];

type SpeakResult = {
  ok: boolean;
  clipId: string;
  audioUrl: string;
  spoken?: string;
  duration?: number | null;
  words?: { text: string; start: number; end: number }[];
  cached?: boolean;
  error?: string;
};

type Playing = {
  url: string;
  mode: string;
};

let activeStop: (() => void) | null = null;
let cachedDefaultMode = "concise";
let settingsFetched = false;

function claim(stop: () => void) {
  if (activeStop && activeStop !== stop) activeStop();
  activeStop = stop;
}

function release(stop: () => void) {
  if (activeStop === stop) activeStop = null;
}

export function SpeakBar({ text, messageId }: { text: string; messageId: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const [busyMode, setBusyMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [paused, setPaused] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [defaultMode, setDefaultMode] = useState(cachedDefaultMode);

  stopRef.current = () => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    audioRef.current = null;
    setPlaying(null);
    setPaused(false);
    setCurrent(0);
    release(stopRef.current);
  };

  useEffect(() => {
    return () => stopRef.current();
  }, [messageId]);

  useEffect(() => {
    if (settingsFetched) {
      setDefaultMode(cachedDefaultMode);
      return;
    }
    settingsFetched = true;
    void fetch("/api/speak/settings")
      .then((r) => r.json())
      .then((d) => {
        const mode = d.settings?.mode || d.speakMode;
        if (mode) {
          cachedDefaultMode = String(mode);
          setDefaultMode(cachedDefaultMode);
        }
      })
      .catch(() => {});
  }, []);

  const attach = (url: string, mode: string) => {
    stopRef.current();
    const a = new Audio(url);
    a.preload = "auto";
    a.playbackRate = rate;
    audioRef.current = a;
    const onTime = () => setCurrent(a.currentTime || 0);
    const onMeta = () => setDuration(a.duration && Number.isFinite(a.duration) ? a.duration : 0);
    const onEnd = () => {
      setPlaying(null);
      setPaused(false);
      setCurrent(0);
      release(stopRef.current);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", () => {
      setError("Couldn't play audio");
      stopRef.current();
    });
    claim(stopRef.current);
    setPlaying({ url, mode });
    setPaused(false);
    void a.play().catch((e) => {
      setError(e?.message || "Play blocked");
      stopRef.current();
    });
  };

  const speak = async (mode: string) => {
    const body = String(text || "").trim();
    if (!body) return;
    if (playing?.mode === mode && audioRef.current) {
      if (paused) {
        void audioRef.current.play();
        setPaused(false);
      } else {
        audioRef.current.pause();
        setPaused(true);
      }
      return;
    }
    setError(null);
    setBusyMode(mode);
    try {
      const resp = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, mode, messageId }),
      });
      const data = (await resp.json().catch(() => ({}))) as SpeakResult;
      if (!resp.ok || !data.ok || !data.audioUrl) {
        throw new Error(data.error || `Speak failed (${resp.status})`);
      }
      attach(data.audioUrl, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speak failed");
    } finally {
      setBusyMode(null);
    }
  };

  const skip = (delta: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min((a.duration || duration || 0) - 0.05, a.currentTime + delta));
  };

  const seek = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    setCurrent(t);
  };

  const cycleRate = () => {
    const i = RATES.indexOf(rate);
    const next = RATES[(i + 1) % RATES.length] || 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="speak-bar">
      <div className="speak-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`speak-chip${playing?.mode === m.id ? " active" : ""}`}
            disabled={Boolean(busyMode) && busyMode !== m.id}
            onClick={() => void speak(m.id)}
            title={`Speak ${m.label.toLowerCase()} recap`}
          >
            {busyMode === m.id ? "…" : m.label}
          </button>
        ))}
        <button
          type="button"
          className={`speak-chip icon${playing?.mode === defaultMode ? " active" : ""}`}
          disabled={Boolean(busyMode) && busyMode !== defaultMode}
          onClick={() => void speak(defaultMode)}
          title={`Speak ${defaultMode}`}
        >
          {busyMode === defaultMode ? "…" : playing && !paused ? <Pause size={12} /> : <Play size={12} />}
        </button>
      </div>
      {playing ? (
        <div className="speak-player">
          <button type="button" className="speak-icon" onClick={() => skip(-15)} title="Back 15s">
            <SkipBack size={13} />
          </button>
          <button
            type="button"
            className="speak-icon"
            onClick={() => void speak(playing.mode)}
            title={paused ? "Play" : "Pause"}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button type="button" className="speak-icon" onClick={() => skip(15)} title="Forward 15s">
            <SkipForward size={13} />
          </button>
          <input
            className="speak-scrub"
            type="range"
            min={0}
            max={Math.max(duration, current, 0.1)}
            step={0.1}
            value={Math.min(current, duration || current)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
          />
          <span className="speak-time">
            {fmt(current)}/{fmt(duration)}
          </span>
          <button type="button" className="speak-chip" onClick={cycleRate} title="Playback speed">
            {rate}×
          </button>
        </div>
      ) : null}
      {error ? <div className="speak-error">{error}</div> : null}
    </div>
  );
}
