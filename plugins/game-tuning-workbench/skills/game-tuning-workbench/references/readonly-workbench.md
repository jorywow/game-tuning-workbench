# Read-only workbench

Use this stage to let the user inspect what Codex found before any tuning control can change a draft or source file.

## Generate

Run from the plugin root:

```bash
node scripts/generate-readonly-workbench.mjs <game-tuning-model.json> --output <workbench-directory>
```

The generator copies the static UI, a model snapshot, metadata, and safe local image previews. It only copies previews that are inside `project.root`, have a supported image extension, and are no larger than 10 MB. Procedural assets remain source-backed placeholders.

## Preview

```bash
node scripts/serve-workbench.mjs <workbench-directory> --host 127.0.0.1 --port 4179
```

Open the printed local URL. Verify that `#app[data-ready="true"]` is present, then exercise all five views:

1. Project overview shows coverage as analysis coverage, not game quality.
2. Worldview separates confirmed facts from inferred narrative.
3. Core gameplay explains the player loop and runtime rules in ordinary language.
4. Tuning shows current values, ranges, owners, direct effects, excluded effects, and source bindings without sliders or save actions.
5. Assets show copied previews or procedural/file placeholders with their source locations.

Also verify search, tuning-group filters, the evidence detail dialog, a narrow viewport, and an empty browser error console.

## Read-only boundary

- Do not add sliders, editable inputs, save buttons, apply buttons, or source writes in this stage.
- Search, filter, navigation, and evidence dialogs are allowed because they do not mutate the model or game.
- Treat the generated directory as a snapshot. Regenerate it after the model or template changes.
- Move to draft tuning only after the user confirms this information architecture and evidence quality.
