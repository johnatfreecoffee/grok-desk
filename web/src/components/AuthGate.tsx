import { useEffect, useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";

type Props = {
  onAuthed: () => void;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function AuthGate({ onAuthed }: Props) {
  const [step, setStep] = useState<"password" | "pin">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinSentRef = useRef("");

  async function submitPassword(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ticket) {
        setError(typeof d.error === "string" ? d.error : "Sign-in failed");
        return;
      }
      setTicket(String(d.ticket));
      setPassword("");
      setPin("");
      pinSentRef.current = "";
      setStep("pin");
    } catch {
      setError("Could not reach lock");
    } finally {
      setBusy(false);
    }
  }

  async function submitPin(digits: string) {
    if (digits.length !== 9 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/pin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, pin: digits }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        pinSentRef.current = "";
        setPin("");
        const msg = typeof d.error === "string" ? d.error : "PIN failed";
        if (r.status === 401 && /ticket/i.test(msg)) {
          setTicket("");
          setStep("password");
        }
        setError(msg);
        return;
      }
      onAuthed();
    } catch {
      pinSentRef.current = "";
      setPin("");
      setError("Could not reach lock");
    } finally {
      setBusy(false);
    }
  }

  function tapDigit(n: string) {
    if (busy) return;
    setError(null);
    setPin((prev) => {
      if (prev.length >= 9) return prev;
      return prev + n;
    });
  }

  function backspace() {
    if (busy) return;
    setPin((p) => p.slice(0, -1));
  }

  useEffect(() => {
    if (step !== "pin" || pin.length !== 9) return;
    if (pinSentRef.current === pin) return;
    pinSentRef.current = pin;
    void submitPin(pin);
  }, [pin, step, ticket]);

  useEffect(() => {
    if (step !== "pin") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        tapDigit(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, busy]);

  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <div className="auth-gate-mark">
          <Lock size={22} strokeWidth={2.2} />
        </div>
        <h1>Grok Desk</h1>
        <p className="auth-gate-sub">Local lock</p>

        {step === "password" ? (
          <form className="auth-gate-form" onSubmit={(e) => void submitPassword(e)}>
            <label className="field">
              <span>Username</span>
              <input
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && <p className="auth-gate-error">{error}</p>}
            <button type="submit" className="auth-gate-submit" disabled={busy}>
              {busy ? "…" : "Continue"}
            </button>
          </form>
        ) : (
          <div className="auth-pin">
            <p className="auth-pin-label">Enter PIN</p>
            <div className="auth-pin-dots" aria-hidden>
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className={i < pin.length ? "filled" : ""} />
              ))}
            </div>
            {error && <p className="auth-gate-error">{error}</p>}
            <div className="auth-numpad">
              {KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="auth-numpad-key"
                  disabled={busy}
                  onClick={() => tapDigit(k)}
                >
                  {k}
                </button>
              ))}
              <button
                type="button"
                className="auth-numpad-key auth-numpad-back"
                disabled={busy}
                onClick={backspace}
                aria-label="Delete"
              >
                ⌫
              </button>
              <button
                type="button"
                className="auth-numpad-key"
                disabled={busy}
                onClick={() => tapDigit("0")}
              >
                0
              </button>
              <span className="auth-numpad-spacer" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
