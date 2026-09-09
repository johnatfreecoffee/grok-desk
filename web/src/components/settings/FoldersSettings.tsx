import { useEffect, useState } from "react";

type FoldersStatus = {
  enabled: boolean;
  running: boolean;
  appPath: string;
  lastPath: string;
  recents: string[];
  defaultOpen: "grok" | "terminal" | string;
  openOnHover: boolean;
  root: string;
};

export function FoldersSettings() {
  const [st, setSt] = useState<FoldersStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastPathDraft, setLastPathDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const apply = (d: FoldersStatus) => {
    setSt(d);
    if (d.lastPath) setLastPathDraft(d.lastPath);
  };

  useEffect(() => {
    fetch("/api/folders", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => apply(d))
      .catch(() => setSt(null));
  }, []);

  const post = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const resp = await fetch("/api/folders", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await resp.json().catch(() => ({}))) as FoldersStatus & { error?: string };
      if (!resp.ok) throw new Error(data.error || "Save failed");
      apply(data);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const commitLastPath = () => {
    if (!st) return;
    const next = lastPathDraft.trim();
    if (!next || next === st.lastPath) return;
    void post({ lastPath: next });
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Folders</div>
      {st ? (
        <>
          <label className="field check">
            <input
              type="checkbox"
              checked={Boolean(st.enabled)}
              disabled={busy}
              onChange={(e) => void post({ enabled: e.target.checked })}
            />
            <span>Show comet in the menu bar</span>
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={st.openOnHover !== false}
              disabled={busy}
              onChange={(e) => void post({ openOnHover: e.target.checked })}
            />
            <span>Open on hover</span>
          </label>
          <label className="field">
            <span>Default open</span>
            <select
              value={st.defaultOpen === "terminal" ? "terminal" : "grok"}
              disabled={busy}
              onChange={(e) => void post({ defaultOpen: e.target.value })}
            >
              <option value="grok">Grok Build</option>
              <option value="terminal">Terminal</option>
            </select>
          </label>
          <label className="field">
            <span>Current folder</span>
            <input
              type="text"
              value={lastPathDraft}
              disabled={busy}
              onChange={(e) => setLastPathDraft(e.target.value)}
              onBlur={commitLastPath}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
            />
          </label>
        </>
      ) : (
        <p className="modal-hint">Loading folders…</p>
      )}
      {msg && <p className="settings-callout">{msg}</p>}
      <p className="modal-hint">
        Comet is part of Grok Desk — it stays in the menu bar while Desk is running, even if you close the window. Click it and type to search folders. Open Grok Desk from the comet menu or File → Open Grok Desk.
      </p>
    </div>
  );
}
