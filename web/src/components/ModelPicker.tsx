import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { buildApi, type ModelInfo } from "../lib/buildClient";

const MODEL_KEY = "grok-desk-model";
const EFFORT_KEY = "grok-desk-effort";

export function loadSavedModel(): { model: string | null; effort: string | null } {
  try {
    return {
      model: localStorage.getItem(MODEL_KEY),
      effort: localStorage.getItem(EFFORT_KEY),
    };
  } catch {
    return { model: null, effort: null };
  }
}

type Props = {
  onSelect: (modelId: string, effort?: string | null) => void;
  compact?: boolean;
};

export function ModelPicker({ onSelect, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState<string>(() => loadSavedModel().model || "grok-4.5");
  const [effort, setEffort] = useState<string | null>(() => loadSavedModel().effort);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void buildApi
      .models()
      .then((r) => {
        const list = r.models || [];
        setModels(list);
        if (list.length && !list.some((m) => m.id === modelId)) {
          setModelId(list[0].id);
        }
        if (!effort && list[0]?.defaultEffort) setEffort(list[0].defaultEffort);
      })
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = models.find((m) => m.id === modelId) || models[0];
  const efforts = current?.reasoningEfforts || [];

  const apply = (id: string, eff?: string | null) => {
    setModelId(id);
    if (eff !== undefined) setEffort(eff);
    try {
      localStorage.setItem(MODEL_KEY, id);
      if (eff) localStorage.setItem(EFFORT_KEY, eff);
      else localStorage.removeItem(EFFORT_KEY);
    } catch {
      /* */
    }
    onSelect(id, eff ?? effort);
    setOpen(false);
  };

  const label = current?.name || modelId;

  return (
    <div className={`model-picker ${compact ? "compact" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="model-picker-btn"
        title="Model"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Cpu size={14} strokeWidth={2} />
        <span className="model-picker-label">{label}</span>
        {effort ? <span className="model-effort-chip">{effort}</span> : null}
        <ChevronDown size={12} strokeWidth={2} />
      </button>
      {open ? (
        <div className="model-picker-menu" role="menu">
          <div className="model-picker-section">Model</div>
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === modelId ? "active" : ""}
              role="menuitem"
              onClick={() => apply(m.id, m.defaultEffort || effort)}
            >
              <strong>{m.name || m.id}</strong>
              {m.description ? <span>{m.description.slice(0, 80)}</span> : null}
            </button>
          ))}
          {efforts.length > 0 ? (
            <>
              <div className="model-picker-section">Effort</div>
              <div className="model-effort-row">
                {efforts.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={`effort-chip ${effort === e.id ? "active" : ""}`}
                    onClick={() => apply(modelId, e.id)}
                  >
                    {e.label || e.id}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
