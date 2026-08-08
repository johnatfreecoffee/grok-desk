/**
 * Grok voice button — geometry from noknok / grok.com (John 2026-07-09).
 * Six bars in a disk; emerald = your mic, blue = Grok talking. No purple.
 */
import { useEffect, useRef } from "react";
import type { VoiceStatus } from "../lib/voiceRealtime";

const GLYPH = [6, 13, 19, 11, 16, 6];
const LIVE_MULT = [0.45, 0.8, 1, 0.65, 0.9, 0.45];

interface Props {
  active: boolean;
  status: VoiceStatus;
  micLevel: number;
  outLevel: number;
  onStart: () => void;
  onStop: () => void;
  size?: "sm" | "lg";
  className?: string;
  disabled?: boolean;
}

export function VoiceWaveButton({
  active,
  status,
  micLevel,
  outLevel,
  onStart,
  onStop,
  size = "sm",
  className = "",
  disabled = false,
}: Props) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const live = useRef({ status, micLevel, outLevel, active });
  live.current = { status, micLevel, outLevel, active };

  const disk = size === "lg" ? 64 : 40;
  const scale = disk / 40;
  const base = GLYPH.map((h) => Math.round(h * scale));
  const maxH = Math.round(22 * scale);
  const minH = Math.round(4 * scale);

  // Idle: dark bars on light disk (visible). Live: emerald you / blue Grok.
  const speaking = active && status === "speaking";
  const hearing = active && status === "listening" && micLevel > 0.015;
  const barColor = speaking ? "#0ea5e9" : hearing ? "#10b981" : "#0b1220";

  useEffect(() => {
    let raf = 0;
    const heights = [...base];
    const idle = () => {
      barsRef.current.forEach((el, i) => {
        if (el) {
          el.style.height = `${base[i]}px`;
          el.style.background = "#0b1220";
        }
      });
    };
    if (!active) {
      idle();
      return;
    }
    const tick = (now: number) => {
      const { status: s, micLevel: mic, outLevel: out } = live.current;
      for (let i = 0; i < 6; i++) {
        let target = base[i];
        if (s === "connecting") {
          const phase = (now / 1400) * Math.PI * 2 - i * 0.9;
          target = minH + (maxH - minH) * Math.pow(Math.max(0, Math.sin(phase)), 1.5);
        } else {
          const level = s === "speaking" ? Math.min(out * 6, 1) : Math.min(mic * 7, 1);
          target =
            minH + (base[i] - minH) * 0.55 + (maxH - minH) * level * LIVE_MULT[i] * 0.75;
        }
        heights[i] += (target - heights[i]) * 0.3;
        const el = barsRef.current[i];
        if (el) {
          el.style.height = `${Math.max(minH * 0.75, Math.min(maxH, heights[i])).toFixed(1)}px`;
          el.style.background =
            s === "speaking" ? "#0ea5e9" : s === "listening" && mic > 0.015 ? "#10b981" : "#0b1220";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      idle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, disk]);

  const bars = (
    <span
      className="vwb-bars"
      style={{ gap: Math.max(2, Math.round(2 * scale)) }}
      aria-hidden
    >
      {base.map((h, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="vwb-bar"
          style={{
            width: Math.max(2, Math.round(2 * scale)),
            height: h,
            background: barColor,
          }}
        />
      ))}
    </span>
  );

  if (!active) {
    return (
      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        title="Talk instead"
        aria-label="Enter voice mode"
        className={`vwb-disk ${className}`}
        style={{ width: disk, height: disk }}
      >
        {bars}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onStop}
      title="End voice"
      aria-label="Stop voice"
      className={`vwb-pill ${className}`}
      style={{ height: disk }}
    >
      {bars}
      <span className="vwb-label">{status === "connecting" ? "…" : "Stop"}</span>
    </button>
  );
}
