import { useEffect, useState } from "react";
import { copyTextToClipboard } from "../../lib/clipboard";

type PhoneMcpStatus = {
  enabled?: boolean;
  running?: boolean;
  health?: string;
  port?: number;
  publicUrl?: string;
  tokenSet?: boolean;
  tokenMasked?: string | null;
  roots?: string[];
};

export function PhoneConnectorSettings() {
  const [st, setSt] = useState<PhoneMcpStatus | null>(null);
  const [publicUrl, setPublicUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    const r = await fetch("/api/phone-mcp");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Could not load phone connector");
    setSt(d);
    if (typeof d.publicUrl === "string") setPublicUrl(d.publicUrl);
    return d as PhoneMcpStatus;
  };

  useEffect(() => {
    void refresh().catch((e) => setErr(e.message || String(e)));
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/phone-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: on }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not update connector");
      setSt(d);
      if (typeof d.publicUrl === "string") setPublicUrl(d.publicUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveUrl = async () => {
    const next = publicUrl.trim();
    if (!next || next === st?.publicUrl) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/phone-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicUrl: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not save URL");
      setSt(d);
      if (typeof d.publicUrl === "string") setPublicUrl(d.publicUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    const ok = await copyTextToClipboard(publicUrl.trim());
    setMsg(ok ? "URL copied" : "Could not copy URL");
  };

  const copyToken = async () => {
    setErr(null);
    try {
      const r = await fetch("/api/phone-mcp/token");
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) throw new Error(d.error || "No token");
      const ok = await copyTextToClipboard(String(d.token));
      setMsg(ok ? "Token copied" : "Could not copy token");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const rotate = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/phone-mcp/rotate", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Rotate failed");
      setSt(d);
      if (typeof d.publicUrl === "string") setPublicUrl(d.publicUrl);
      setMsg("Token rotated");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const healthOk = st?.health === "ok";

  return (
    <div className="settings-section">
      <div className="settings-section-title">Phone connector</div>
      <label className="field check">
        <input
          type="checkbox"
          checked={Boolean(st?.enabled)}
          disabled={busy || !st}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Enable grok.com connector</span>
      </label>
      {st && (
        <p className={healthOk ? "settings-ok" : "settings-callout"}>
          {healthOk ? "ok" : "down"}
          {st.port ? ` · :${st.port}` : ""}
        </p>
      )}
      <label className="field">
        <span>Public URL</span>
        <input
          type="text"
          value={publicUrl}
          disabled={busy}
          onChange={(e) => setPublicUrl(e.target.value)}
          onBlur={() => void saveUrl()}
        />
      </label>
      <div className="settings-app-actions">
        <button type="button" className="icon-btn" onClick={() => void copyUrl()} disabled={!publicUrl.trim()}>
          Copy URL
        </button>
      </div>
      <label className="field">
        <span>Token</span>
        <input type="text" value={st?.tokenMasked || (st?.tokenSet ? "••••" : "")} readOnly />
      </label>
      <div className="settings-app-actions">
        <button type="button" className="icon-btn" onClick={() => void copyToken()} disabled={!st?.tokenSet}>
          Copy token
        </button>
        <button type="button" className="icon-btn" onClick={() => void rotate()} disabled={busy}>
          Rotate
        </button>
      </div>
      {msg && <p className="settings-ok">{msg}</p>}
      {err && <p className="settings-callout">{err}</p>}
      <p className="modal-hint">
        grok.com → Connectors → Custom → this URL. Mac must stay awake. Token is the lock.
      </p>
    </div>
  );
}
