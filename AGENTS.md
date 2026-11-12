# Fluxcut invariants

## The statechart owns everything

Every user intent is one machine event. Convert any of these into component-local
state and you have broken the pattern:

- domain state lives only in `FluxcutContext` (src/lib/machine.ts);
- components subscribe through typed selectors (useFluxcutSelector / Fields / view
  models) and send one event per intent via the `useFluxcutActions` facade;
- component refs store DOM handles and ephemeral render state only (media element
  registry, attachment guards) — never domain values;
- placement and validation decisions belong in pure helpers (src/lib/timeline.ts)
  that return null on an illegal change; events apply the projection and keep the
  previous state on null;
- the compositor and file-input clicks are consequences of machine state, driven
  by effects from view models, never user-acted logic.
