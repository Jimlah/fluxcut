import { useCallback } from "react";
import { useFluxcutActions } from "../lib/useFluxcut";

/** The single hidden file input. The machine opens it on REQUEST_PICK_FILE. */
export default function FilePicker() {
  const actions = useFluxcutActions();

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
      accept="video/*,.mkv,.ts,.m4v"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) actions.loadFile(f);
        e.target.value = "";
      }}
    />
  );
}
