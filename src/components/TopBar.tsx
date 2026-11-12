import { PencilLine, Plus, Redo2, Undo2 } from "lucide-react";
import { useFluxcutActions, useFluxcutHistory, useFluxcutSelector } from "../lib/useFluxcut";

/** Project title pill, undo/redo, and the "load a video" shortcut. */
export default function TopBar() {
  const actions = useFluxcutActions();
  const projectName = useFluxcutSelector((s) => s.context.projectName);
  const { canUndo, canRedo } = useFluxcutHistory();

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
      <button className="circle-btn" title="Undo" disabled={!canUndo} onClick={() => actions.undo()}>
        <Undo2 />
      </button>
      <button className="circle-btn" title="Redo" disabled={!canRedo} onClick={() => actions.redo()}>
        <Redo2 />
      </button>
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
