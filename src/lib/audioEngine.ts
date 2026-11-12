// Preview audio engine: one shared AudioContext and a per-clip Web Audio
// graph. The Compositor nudges every graph toward the machine's mix state on
// each clock tick — the engine stores no time and takes input from nothing but
// the (element, target gain, params) triples it is handed.
//
//   element source -> high-pass 90 Hz -> low shelf -> peaking -> high shelf
//     -> compressor -> expander (gate) -> gain -> destination
//
// MediaElementAudioSource nodes capture their element for good, so a graph is
// attached once per element instance and rebuilt only when the element changes.

export interface EngineMixParams {
  eqOn: boolean;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  compressOn: boolean;
  compressAmount: number;
  cleanOn: boolean;
}

const DB_EPS = 0.001;

interface ClipGraph {
  el: HTMLVideoElement | HTMLAudioElement;
  src: MediaElementAudioSourceNode;
  hp: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  gate: DynamicsCompressorNode;
  gain: GainNode;
  applied: EngineMixParams | null;
  /** Last target gain the machine projected; the automation value chases it. */
  targetGain: number;
}

export interface MixSnapshot {
  gains: Record<string, number>;
  /** The last target each clip's gain was driven toward (exactly what the
   * machine projected), independent of the context's run state. */
  targets: Record<string, number>;
  /** Per-clip node params as the nodes hold them right now. */
  params: Record<string, { hp: number; low: number; mid: number; high: number; thr: number; ratio: number }>;
  nodes: number;
  state: string;
  /** Graph constructions since the engine started; should stay flat per clip. */
  rebuilds: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graphs = new Map<string, ClipGraph>();
  private chainBuilds = 0;
  // A media element accepts exactly one MediaElementAudioSourceNode for its
  // whole lifetime, and React can hand the same DOM node back on remount
  // (StrictMode/activity). Stash the node per element and rebuild the rest of
  // the chain from it instead of constructing a second node over one element.
  private byElement = new WeakMap<HTMLVideoElement | HTMLAudioElement, MediaElementAudioSourceNode>();

  ensure(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  /** Binds an element to its clip's graph. A changed element rebuilds the graph
   * cleanly; a bound element is a no-op. Returns true when the graph changed.
   * Params start neutral; the next applyMix call tunes them. */
  attach(clipId: string, element: HTMLVideoElement | HTMLAudioElement): boolean {
    const existing = this.graphs.get(clipId);
    if (existing && existing.el === element) return false;
    const ctx = this.ensure();
    if (existing) this.detach(clipId);
    let src = this.byElement.get(element);
    if (!src) {
      src = new MediaElementAudioSourceNode(ctx, { mediaElement: element });
      this.byElement.set(element, src);
    }
    const biquad = (type: BiquadFilterType, freq: number, q?: number) => {
      const node = new BiquadFilterNode(ctx, { type, frequency: freq });
      if (q != null) node.Q.value = q;
      return node;
    };
    const hp = biquad("highpass", 90);
    const low = biquad("lowshelf", 120);
    const mid = biquad("peaking", 1500, 0.8);
    const high = biquad("highshelf", 4500);
    const comp = new DynamicsCompressorNode(ctx, {
      threshold: -6,
      knee: 24,
      ratio: 3,
      attack: 0.01,
      release: 0.25,
    });
    // Fixed settings act as an expander: content below the threshold backs off
    // at ratio 20, which lowers steady hiss and hum under the program level.
    const gate = new DynamicsCompressorNode(ctx, {
      threshold: -45,
      knee: 3,
      ratio: 20,
      attack: 0.003,
      release: 0.15,
    });
    const gain = new GainNode(ctx, { gain: 1 });
    this.chainBuilds += 1;
    src
      .connect(hp)
      .connect(low)
      .connect(mid)
      .connect(high)
      .connect(comp)
      .connect(gate)
      .connect(gain)
      .connect(ctx.destination);
    this.graphs.set(clipId, { el: element, src, hp, low, mid, high, comp, gate, gain, applied: null, targetGain: 1 });
    return true;
  }

  /** Pushes params + target gain toward the machine state. Cheap and safe to
   * call every clock tick. */
  applyMix(clipId: string, mix: EngineMixParams, targetGain: number): void {
    const graph = this.graphs.get(clipId);
    if (!graph) return;
    const ctx = this.ensure();
    const g = graph.gain.gain;
    if (Number.isFinite(targetGain)) {
      graph.targetGain = targetGain;
      g.setTargetAtTime(targetGain, ctx.currentTime, 0.03);
    }
    const fresh =
      !graph.applied ||
      graph.applied.eqOn !== mix.eqOn ||
      Math.abs(graph.applied.eqLowDb - mix.eqLowDb) > DB_EPS ||
      Math.abs(graph.applied.eqMidDb - mix.eqMidDb) > DB_EPS ||
      Math.abs(graph.applied.eqHighDb - mix.eqHighDb) > DB_EPS ||
      graph.applied.compressOn !== mix.compressOn ||
      Math.abs(graph.applied.compressAmount - mix.compressAmount) > DB_EPS ||
      graph.applied.cleanOn !== mix.cleanOn;
    if (!fresh) return;
    graph.hp.frequency.value = mix.cleanOn ? 90 : 20;
    graph.low.gain.value = mix.eqOn ? mix.eqLowDb : 0;
    graph.mid.gain.value = mix.eqOn ? mix.eqMidDb : 0;
    graph.high.gain.value = mix.eqOn ? mix.eqHighDb : 0;
    const amount = Math.max(0, Math.min(1, mix.compressAmount));
    graph.comp.threshold.value = mix.compressOn ? -6 - 34 * amount : 0;
    graph.comp.ratio.value = mix.compressOn ? 3 + 9 * amount : 1;
    graph.comp.knee.value = mix.compressOn ? 24 : 0;
    graph.gate.threshold.value = mix.cleanOn ? -45 : 0;
    graph.gate.ratio.value = mix.cleanOn ? 20 : 1;
    graph.gate.knee.value = mix.cleanOn ? 3 : 0;
    graph.applied = { ...mix };
  }

  /** Drops graphs whose clip no longer exists in the given id set; the
   * Compositor calls this per tick so unmounted elements never leak chains. */
  gc(alive: Iterable<string>): void {
    const keep = new Set(alive);
    for (const clipId of [...this.graphs.keys()]) {
      if (!keep.has(clipId)) this.detach(clipId);
    }
  }

  detach(clipId: string): void {
    const graph = this.graphs.get(clipId);
    if (!graph) return;
    this.graphs.delete(clipId);
    try {
      // The source node stays stashed for same-element remounts, but its
      // output is cut so an orphaned chain stops pulling audio.
      graph.src.disconnect();
      graph.hp.disconnect();
      graph.low.disconnect();
      graph.mid.disconnect();
      graph.high.disconnect();
      graph.comp.disconnect();
      graph.gate.disconnect();
      graph.gain.disconnect();
    } catch {
      /* the context may already be closing */
    }
  }

  /** The autoplay policy: resume whenever a playback tick says the gesture exists. */
  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  /** Dev-harness snapshot: graph ids, node count, target gains, context state. */
  snapshot(): MixSnapshot {
    const gains: Record<string, number> = {};
    const targets: Record<string, number> = {};
    const params: MixSnapshot["params"] = {};
    for (const [clipId, graph] of this.graphs) {
      gains[clipId] = graph.gain.gain.value;
      targets[clipId] = graph.targetGain;
      params[clipId] = {
        hp: graph.hp.frequency.value,
        low: graph.low.gain.value,
        mid: graph.mid.gain.value,
        high: graph.high.gain.value,
        thr: graph.comp.threshold.value,
        ratio: graph.comp.ratio.value,
      };
    }
    return {
      gains,
      targets,
      params,
      nodes: this.graphs.size,
      state: this.ctx ? this.ctx.state : "uninitialized",
      rebuilds: this.chainBuilds,
    };
  }
}

/** The one engine instance shared by the Compositor and the dev harness. */
export const audioEngine = new AudioEngine();