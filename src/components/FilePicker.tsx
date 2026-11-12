import { useCallback, useEffect, useRef } from "react";
import { useFluxcutActions, useFluxcutFields } from "../lib/useFluxcut";

/**
 * The single hidden file input. The machine bumps pickNonce for the main
 * video or for a kind-filtered track clip; the effect below clicks the input
 * only after the accept attribute has re-rendered, so each lane kind opens
 * with the right filter.
 */
export default function FilePicker() {
  const actions = useFluxcutActions();
  const { pickTarget, pickAccept, pickNonce } = useFluxcutFields([
    "pickTarget",
    "pickAccept",
    "pickNonce",
  ]);

  const attachInput = useCallback(
    (el: HTMLInputElement | null) => {
      if (el) actions.attachInput(el);
    },
    [actions]
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (pickNonce === 0) return;
    inputRef.current?.click();
  }, [pickNonce]);

  return (
    <input
      ref={(el) => { inputRef.current = el; attachInput(el); }}
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