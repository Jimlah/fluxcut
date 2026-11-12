import {
  WandSparkles,
  X,
  CloudUpload,
  ArrowDownToLine,
  CircleAlert,
  Check,
  ShieldCheck,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { FORMATS, RESOLUTIONS, QUALITIES } from "../lib/convert";
import { useFluxcutActions, useFluxcutBusy, useFluxcutFields, useFluxcutStatus, useFluxcutView } from "../lib/useFluxcut";

export default function ConvertPanel() {
  const actions = useFluxcutActions();

  // One grouped subscription + destructure; re-renders only when one of these
  // fields actually changes (shallow compare), not on every context mutation.
  const {
    panelOpen: open,
    file,
    meta: fileMeta,
    formatId,
    resId,
    qualityId,
    progress,
    engineNote,
    error,
    result,
    supportedFormats,
    capsProbed,
    urlDraft,
  } = useFluxcutFields([
    "panelOpen",
    "file",
    "meta",
    "formatId",
    "resId",
    "qualityId",
    "trim",
    "progress",
    "engineNote",
    "error",
    "result",
    "supportedFormats",
    "capsProbed",
    "urlDraft",
  ] as const);

  // Everything rendered as text comes pre-formatted from the machine layer
  const view = useFluxcutView();

  // Derived from machine state tags, via hooks
  const status = useFluxcutStatus();
  const busy = useFluxcutBusy();

  const formatSupported = (id: string) =>
    !capsProbed || supportedFormats.includes(id);

  if (!open) return null;

  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="icon">
          <WandSparkles />
        </div>
        <h2>Convert</h2>
        <button className="close" onClick={() => actions.setPanelOpen(false)} title="Close panel">
          <X />
        </button>
      </div>

      <div className="panel-body">
        {!file ? (
          <>
            <div className="dropzone" onClick={() => actions.pickFile()}>
              <div className="dz-icon">
                <CloudUpload />
              </div>
              <b>Drop a video here</b>
              <span>or click to browse — nothing leaves your device</span>
            </div>
            <form
              className="url-row"
              onSubmit={(e) => {
                e.preventDefault();
                actions.submitUrl();
              }}
            >
              <input
                value={urlDraft}
                onChange={(e) => actions.setUrlDraft(e.target.value)}
                placeholder="…or paste a video URL"
                spellCheck={false}
                inputMode="url"
              />
              <button type="submit" disabled={!urlDraft.trim() || busy}>
                Fetch
              </button>
            </form>
          </>
        ) : (
          <div className="file-chip">
            <div
              className="thumb"
              style={{ backgroundImage: fileMeta.poster ? `url(${fileMeta.poster})` : undefined }}
            />
            <div className="meta">
              <div className="name" title={file.name}>
                {file.name}
              </div>
              <div className="sub">
                {view.fileSizeText} · {view.metaDurationText} · {fileMeta.w}×{fileMeta.h}
              </div>
            </div>
            {!busy && (
              <>
                <button className="swap" onClick={() => actions.pickFile()}>
                  Replace
                </button>
                <button className="swap ghost" onClick={() => actions.clear()} title="Remove video">
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        )}

        <div className="field">
          <div className="label">
            Format
            <span className="hint">{capsProbed ? "supported by this browser" : "checking browser…"}</span>
          </div>
          <div className="chip-row">
            {FORMATS.map((f) => {
              const ok = formatSupported(f.id);
              return (
                <button
                  key={f.id}
                  className={`chip${formatId === f.id ? " on" : ""}`}
                  disabled={busy || !ok}
                  title={ok ? undefined : "Not supported by this browser's encoder"}
                  onClick={() => actions.setFormat(f.id)}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <div className="label">
            Resolution <span className="hint">short side</span>
          </div>
          <div className="chip-row">
            {RESOLUTIONS.map((r) => (
              <button
                key={r.id}
                className={`chip${resId === r.id ? " on" : ""}`}
                disabled={busy}
                onClick={() => actions.setRes(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="label">Quality</div>
          <div className="chip-row">
            {QUALITIES.map((q) => (
              <button
                key={q.id}
                className={`chip${qualityId === q.id ? " on" : ""}`}
                disabled={busy}
                onClick={() => actions.setQuality(q.id)}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>

        {file && (
          <div className="field">
            <div className="label">
              Trim <span className="hint">drag playhead · set In/Out</span>
            </div>
            <div className="trim-row">
              <div className="seg">
                <b>{view.trimInText}</b>
                <span>In</span>
              </div>
              <div className="seg">
                <b>{view.trimLenText}</b>
                <span>Length</span>
              </div>
              <div className="seg">
                <b>{view.trimOutText}</b>
                <span>Out</span>
              </div>
              <button className="reset" onClick={() => actions.resetTrim()} title="Reset trim">
                <RotateCcw size={13} />
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="error-card">
            <CircleAlert />
            <span>{error}</span>
          </div>
        )}

        {file && status !== "done" && !busy && (
          <button className="convert-btn" onClick={() => actions.convert()}>
            Convert to {FORMATS.find((f) => f.id === formatId)?.label} <WandSparkles />
          </button>
        )}

        {busy && (
          <div className="progress-block">
            <div className="row">
              <span>
                {status === "downloading"
                  ? "Fetching URL…"
                  : status === "loading"
                    ? "Warming up encoder…"
                    : "Converting…"}
              </span>
              <span className="pct">{Math.round(progress * 100)}%</span>
            </div>
            <div className="bar">
              <i style={{ width: `${(status === "loading" ? 0.04 : progress) * 100}%` }} />
            </div>
            {engineNote && <div className="row" style={{ color: "var(--ink-3)" }}>{engineNote}</div>}
            <button className="cancel" onClick={() => actions.cancel()}>
              Cancel
            </button>
          </div>
        )}

        {status === "done" && result && (
          <div className="result-card">
            <div className="row">
              <span className="check">
                <Check />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="name" title={result.name}>
                  {result.name}
                </div>
                <div className="sub">
                  {view.resultSizeText} · {result.dims.width}×{result.dims.height} ·{" "}
                  {result.codec.toUpperCase()}
                </div>
              </div>
            </div>
            <a className="download" href={result.url} download={result.name}>
              <ArrowDownToLine /> Download
            </a>
            <button className="again" onClick={() => actions.again()}>
              Convert again
            </button>
          </div>
        )}
      </div>

      <div className="panel-foot">
        <ShieldCheck /> 100% in-browser via mediabunny · assets: Mixkit, Google Fonts, Lucide
      </div>
    </aside>
  );
}