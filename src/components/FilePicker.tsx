import { useCallback } from "react";
import { useFluxcutActions, useFluxcutFields } from "../lib/useFluxcut";

/**
 * The single hidden file input. The machine opens it for the main video, or —
 * when a track pick is pending (pickTarget) — for a kind-filtered track clip.
 */
export default function FilePicker() {
  const actions = useFluxcutActions();
  const { pickTarget, pickAccept } = useFluxcutFields(["pickTarget", "pickAccept"]);

  const attachInput = useCallback(
    (el: HTMLInputElement | null) => {
      if (el) actions.attachInput(el);
    },
    [actions]
  );

  return (
    <input
      ref={attachInput}
      type="file"
      accept={pickAccept}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) {
          if (pickTarget) actions.addMediaClip(pickTarget, f);
          else actions.loadFile(f);
        }
        e.target.value = "";
      }}
    />
  );
}
