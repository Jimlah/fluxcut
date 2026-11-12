import { useCallback, useEffect, useRef } from "react";
import { audioEngine } from "../lib/audioEngine";
import { useFluxcutActions, usePreview } from "../lib/useFluxcut";
import type { ClipId } from "../lib/timeline";
import type { PreviewLayer } from "../lib/useFluxcut";

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

/**
 * The multi-layer stage. One element per media clip, keyed by clip id in a
 * local ref map (never context); visual layers stack by lane z-order. The
 * effect nudges active video/audio toward the machine's composition clock
 * (seek on >0.05s drift, then play) and pauses inactive ones — the machine
 * owns time, elements only follow. The same effect pushes each clip's mix
 * (Web Audio graph params + interpolated gain) into the audio engine, so
 * sound follows machine state the same way frames follow the clock.
 */
export default function Compositor() {
  const actions = useFluxcutActions();
  const vm = usePreview();
  const els = useRef(new Map<ClipId, MediaEl>());

  // One ref callback per clip id, cached: a fresh closure per render would
  // make React detach and re-attach the ref on every commit, tearing the
  // clip's audio graph down per tick. Dead graphs are collected per tick via
  // engine.gc instead of a cleanup function.
  const putFns = useRef(new Map<ClipId, (el: MediaEl | null) => void>());

  const bindRef = useCallback(
    (clipId: ClipId, sound: boolean) => {
      let put = putFns.current.get(clipId);
      if (!put) {
        put = (el: MediaEl | null) => {
          if (el) {
            els.current.set(clipId, el);
            if (sound) audioEngine.attach(clipId, el as HTMLVideoElement | HTMLAudioElement);
          } else {
            if (els.current.get(clipId)) els.current.delete(clipId);
            if (sound) audioEngine.detach(clipId);
          }
        };
        putFns.current.set(clipId, put);
      }
      return put;
    },
    []
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __FLUXCUT_MIX__?: unknown }).__FLUXCUT_MIX__ = {
        snapshot: () => audioEngine.snapshot(),
      };
    }
    if (vm.playing) audioEngine.resume();
    // Collect graphs whose element left the stage (clip deleted, file reset)
    // and drop the per-clip ref closures that outlived their clips.
    const alive = new Set(
      vm.layers.filter((l) => l.media && l.media.elKind !== "image").map((l) => l.clipId)
    );
    audioEngine.gc(alive);
    for (const clipId of [...putFns.current.keys()]) {
      if (!alive.has(clipId)) putFns.current.delete(clipId);
    }
    for (const layer of vm.layers) {
      if (!layer.media || layer.media.elKind === "image" || !layer.media.mix) continue;
      const el = els.current.get(layer.clipId);
      if (!el) continue;
      const media = el as HTMLVideoElement | HTMLAudioElement;
      audioEngine.applyMix(layer.clipId, layer.media.mix, layer.media.mixGain);
      // An active clip whose video keeps running while the composition is
      // paused is wrong: media follows the clock, so pause covers both cases.
      if (!layer.media.active || !vm.playing) {
        media.pause();
        continue;
      }
      // Retime on speed changes so 0.25x / 8x playback stays smooth between nudges.
      if (media.playbackRate !== layer.media.speed) {
        media.playbackRate = layer.media.speed;
      }
      if (media.readyState >= 1 && Math.abs(media.currentTime - layer.media.sourceTime) > 0.05) {
        const d = isFinite(media.duration) ? media.duration : Infinity;
        media.currentTime = Math.max(0, Math.min(layer.media.sourceTime, d - 0.05));
      }
      if (media.paused) void media.play().catch(() => {});
    }
  }, [vm]);

  return (
    <div className="compositor" onClick={() => actions.togglePlay()}>
      {vm.layers.map((layer) => (
        <Layer key={layer.clipId} layer={layer} bindRef={bindRef} />
      ))}
    </div>
  );
}

function Layer({
  layer,
  bindRef,
}: {
  layer: PreviewLayer;
  bindRef: (clipId: ClipId, sound: boolean) => (el: MediaEl | null) => void;
}) {
  const style = {
    zIndex: layer.kind === "audio" ? undefined : layer.z,
    visibility: layer.active ? ("visible" as const) : ("hidden" as const),
  };
  const sound = layer.media?.elKind === "video" || layer.media?.elKind === "audio";
  const put = bindRef(layer.clipId, sound);
  if (layer.kind === "text") {
    return (
      <div className="comp-layer comp-text" style={style}>
        {layer.text}
      </div>
    );
  }
  if (layer.kind === "image" && layer.media) {
    return <img className="comp-layer" style={style} src={layer.media.src} alt="" ref={put} />;
  }
  if (layer.kind === "video" && layer.media) {
    return (
      <video className="comp-layer" style={style} src={layer.media.src} playsInline preload="auto" ref={put} />
    );
  }
  return <audio src={layer.media?.src} ref={put} hidden />;
}