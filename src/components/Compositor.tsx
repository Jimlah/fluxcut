import { useEffect, useRef, type RefObject } from "react";
import { useFluxcutActions, usePreview } from "../lib/useFluxcut";
import type { PreviewLayer } from "../lib/useFluxcut";
import type { ClipId } from "../lib/timeline";

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

/**
 * The multi-layer stage. One element per media clip, keyed by clip id in a
 * local ref map (never context); visual layers stack by lane z-order. The
 * effect nudges active video/audio toward the machine's composition clock
 * (seek on >0.05s drift, then play) and pauses inactive ones — the machine
 * owns time, elements only follow.
 */
export default function Compositor() {
  const actions = useFluxcutActions();
  const vm = usePreview();
  const els = useRef(new Map<ClipId, MediaEl>());

  useEffect(() => {
    for (const layer of vm.layers) {
      if (!layer.media || layer.media.elKind === "image") continue;
      const el = els.current.get(layer.clipId);
      if (!el) continue;
      const media = el as HTMLVideoElement | HTMLAudioElement;
      // An active clip whose video keeps running while the composition is
      // paused is wrong: media follows the clock, so pause covers both cases.
      if (!layer.media.active || !vm.playing) {
        media.pause();
        continue;
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
        <Layer key={layer.clipId} layer={layer} elsRef={els} />
      ))}
    </div>
  );
}

function Layer({ layer, elsRef }: { layer: PreviewLayer; elsRef: RefObject<Map<ClipId, MediaEl>> }) {
  const style = {
    zIndex: layer.kind === "audio" ? undefined : layer.z,
    visibility: layer.active ? ("visible" as const) : ("hidden" as const),
  };
  const put = (el: MediaEl | null) => {
    if (el) elsRef.current.set(layer.clipId, el);
    return () => {
      elsRef.current.delete(layer.clipId);
    };
  };
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
