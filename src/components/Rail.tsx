import {
  ArrowLeft,
  Clapperboard,
  AudioLines,
  Music2,
  Languages,
  Users,
  Type,
} from "lucide-react";
import { useFluxcutActions, useFluxcutSelector } from "../lib/useFluxcut";

const TOOLS = [
  { icon: Clapperboard, key: "clip", hint: "Clip" },
  { icon: AudioLines, key: "wave", hint: "Waveform" },
  { icon: Music2, key: "music", hint: "Music" },
  { icon: Languages, key: "translate", hint: "Translate" },
  { icon: Users, key: "people", hint: "People" },
  { icon: Type, key: "text", hint: "Text" },
];

export default function Rail() {
  const actions = useFluxcutActions();
  const activeTool = useFluxcutSelector((s) => s.context.activeTool);

  return (
    <nav className="rail">
      <button className="circle-btn" title="Back">
        <ArrowLeft />
      </button>
      {TOOLS.map((t, i) => (
        <button
          key={t.key}
          title={t.hint}
          className={`circle-btn${i === 0 ? " primary" : " tint"}${activeTool === t.key ? " active" : ""}`}
          onClick={() => actions.setTool(t.key)}
        >
          <t.icon />
        </button>
      ))}
    </nav>
  );
}
