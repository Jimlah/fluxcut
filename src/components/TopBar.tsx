import { PencilLine, Plus } from "lucide-react";
import { useFluxcutActions, useFluxcutSelector } from "../lib/useFluxcut";

/** Project title pill + the "load a video" shortcut. */
export default function TopBar() {
  const actions = useFluxcutActions();
  const projectName = useFluxcutSelector((s) => s.context.projectName);

  return (
    <div className="topbar">
      <div className="pill title-pill">
        <input
          value={projectName}
          onChange={(e) => actions.setProjectName(e.target.value)}
          placeholder="Untitled conversion"
          spellCheck={false}
        />
        <PencilLine className="edit-icon" style={{ width: 15, height: 15 }} />
      </div>
      <button
        className="circle-btn"
        title="Load a video"
        onClick={() => actions.pickFile()}
      >
        <Plus />
      </button>
    </div>
  );
}
