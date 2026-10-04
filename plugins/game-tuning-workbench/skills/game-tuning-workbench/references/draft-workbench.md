# Draft tuning workbench

Use this stage after the user accepts the read-only information architecture. It lets a non-programmer try parameter values without changing the analyzed game.

## Generate

Run from the plugin root:

```bash
node scripts/generate-draft-workbench.mjs <game-tuning-model.json> --output <workbench-directory>
```

Preview it with the same local server used by the read-only workbench:

```bash
node scripts/serve-workbench.mjs <workbench-directory> --host 127.0.0.1 --port 4179
```

`workbench-meta.json` must report `mode: "draft"`. The generated directory remains a model snapshot and contains no game-source writer.

## Parameter gate

Only expose a draft control when the parameter has:

- a stable parameter ID and one owner;
- a numeric `currentValue`;
- a `safeRange` with minimum, maximum, and step;
- an editable source binding; and
- a real preview/runtime consumer recorded by the model.

If one of these is missing, show the evidence and keep that parameter unavailable for editing.

## Draft behavior

- Store `before` and `after` for each parameter independently.
- Snap values to the declared step and clamp them to the declared safe range.
- Persist only browser-local draft state, keyed by the model ID. Ignore stale entries whose recorded `before` no longer equals the model's current value.
- Show original value, draft value, ordinary-language direction, direct effects, and excluded effects together.
- Support per-parameter restore and confirmed discard-all without touching source files.
- Generate a schema-shaped ChangeSet preview in `draft` state. It must keep `confirmation.confirmedAt` null and verification `not-run`.

## Independence boundary

One control changes one target ID. Never change another parameter merely because it belongs to the same group. List known dependency target IDs in the ChangeSet, but do not silently edit them. Preserve every excluded effect as an explicit acceptance invariant.

The workbench's semantic preview is not a gameplay verification. Do not claim the game feel changed until a later confirmed application writes the source and the affected runtime behavior is exercised in a browser.

## Acceptance

Verify that:

1. a slider and exact-value input stay synchronized;
2. the draft counter, original/draft comparison, and impact list update immediately;
3. one parameter can be restored without changing another draft;
4. refreshing restores valid browser-local drafts;
5. the ChangeSet preview contains only the selected operations and no application action;
6. discard-all requires confirmation and returns the workbench to zero drafts; and
7. the layout remains usable on a narrow viewport.
