import { Plus, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { EQ_DB_MAX, MAX_KEYFRAMES, MIX_GAIN_MAX, findClipEntry } from "../lib/timeline";
import { useFluxcutActions, useFluxcutFields, useFluxcutSelector } from "../lib/useFluxcut";

/**
 * The audio mixer for the selected sound-carrying clip, shown behind the rail's
 * mix tool. Every control sends exactly one machine event per change; slider
 * bursts coalesce in the statechart, so undo sees one step per control.
 */
export default function MixerPanel() {
  const actions = useFluxcutActions();
  const tool = useFluxcutSelector((s) => s.context.activeTool);
  const panelOpen = useFluxcutSelector((s) => s.context.panelOpen);
  const { timeline, selectedClipId, time } = useFluxcutFields(["timeline", "selectedClipId", "time"]);

  if (!panelOpen || tool !== "mix" || !selectedClipId) return null;
  const entry = findClipEntry(timeline, selectedClipId);
  if (!entry) return null;
  const clip = entry.clip;
  if (clip.kind !== "video" && clip.kind !== "audio") return null;
  const mix = clip.mix;
  const track = entry.track;
  const trackDuck = track.kind === "video" || track.kind === "audio" ? track.duck : null;
  const inSpan = time >= clip.start && time < clip.start + clip.duration;

  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="icon">
          <SlidersHorizontal />
        </div>
        <h2>Audio mix</h2>
        <button className="close" onClick={() => actions.setTool("mix")} title="Switch back to the clip tool">
          <X />
        </button>
      </div>

      <div className="panel-body">
        <div className="mixer-clip">
          {clip.kind === "video" ? "Video clip" : "Audio clip"} · {(clip.duration).toFixed(1)}s
        </div>

        <div className="field">
          <div className="label">
            <span>Volume</span>
            <span className="hint">{Math.round(mix.gain * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={MIX_GAIN_MAX}
            step={0.01}
            value={mix.gain}
            onChange={(e) => actions.setClipMix(selectedClipId, "volume", { gain: Number(e.target.value) })}
          />
        </div>

        <div className="field">
          <div className="label">
            <span>Keyframes</span>
            <span className="hint">{mix.keyframes.length}/{MAX_KEYFRAMES}</span>
          </div>
          <button
            className="mixer-btn"
            disabled={!inSpan || mix.keyframes.length >= MAX_KEYFRAMES}
            title={inSpan ? "Add a keyframe at the playhead" : "Move the playhead over this clip first"}
            onClick={() =>
              actions.addKeyframe(selectedClipId, Math.round((time - clip.start) * 1000) / 1000, mix.gain)
            }
          >
            <Plus /> Add at playhead
          </button>
          {mix.keyframes.map((k) => (
            <div className="mixer-kf" key={k.t}>
              <span className="mixer-kf-t">{k.t.toFixed(2)}s</span>
              <input
                type="range"
                min={0}
                max={MIX_GAIN_MAX}
                step={0.01}
                value={k.g}
                onChange={(e) => actions.addKeyframe(selectedClipId, k.t, Number(e.target.value))}
              />
              <span>{Math.round(k.g * 100)}%</span>
              <button
                className="mixer-x"
                title="Remove this keyframe"
                onClick={() => actions.removeKeyframe(selectedClipId, k.t)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="field">
          <div className="label">
            <span>EQ</span>
            <button
              className={"mixer-toggle" + (mix.eqOn ? " on" : "")}
              onClick={() => actions.setClipMix(selectedClipId, "eq", { eqOn: !mix.eqOn })}
            >
              {mix.eqOn ? "On" : "Off"}
            </button>
          </div>
          {(["eqLowDb", "eqMidDb", "eqHighDb"] as const).map((band, i) => (
            <div className="mixer-kf" key={band}>
              <span className="mixer-kf-t">{["Low", "Mid", "High"][i]}</span>
              <input
                type="range"
                min={-EQ_DB_MAX}
                max={EQ_DB_MAX}
                step={0.5}
                value={mix[band]}
                disabled={!mix.eqOn}
                onChange={(e) => actions.setClipMix(selectedClipId, band, { [band]: Number(e.target.value) })}
              />
              <span>{mix[band].toFixed(1)} dB</span>
            </div>
          ))}
        </div>

        <div className="field">
          <div className="label">
            <span>Compression</span>
            <button
              className={"mixer-toggle" + (mix.compressOn ? " on" : "")}
              onClick={() => actions.setClipMix(selectedClipId, "comp", { compressOn: !mix.compressOn })}
            >
              {mix.compressOn ? "On" : "Off"}
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={mix.compressAmount}
            disabled={!mix.compressOn}
            onChange={(e) => actions.setClipMix(selectedClipId, "amount", { compressAmount: Number(e.target.value) })}
          />
        </div>

        <div className="field">
          <div className="label">
            <span>Clean (hiss, hum)</span>
            <button
              className={"mixer-toggle" + (mix.cleanOn ? " on" : "")}
              onClick={() => actions.setClipMix(selectedClipId, "clean", { cleanOn: !mix.cleanOn })}
            >
              {mix.cleanOn ? "On" : "Off"}
            </button>
          </div>
        </div>

        {trackDuck != null && (
          <div className="field">
            <div className="label">
              <span>{track.name} · duck under dialogue</span>
              <button
                className={"mixer-toggle" + (trackDuck ? " on" : "")}
                onClick={() => actions.setTrackDuck(track.id, !trackDuck)}
              >
                {trackDuck ? "Ducking" : "Off"}
              </button>
            </div>
            <span className="mixer-hint">
              {trackDuck
                ? "This lane lowers itself while dialogue plays."
                : "This lane keeps its level; other lanes duck under it."}
            </span>
          </div>
        )}

        <button className="mixer-btn ghost" onClick={() => actions.resetClipMix(selectedClipId)}>
          <RotateCcw /> Reset clip mix
        </button>
      </div>
    </aside>
  );
}