# Three.js project analyzer

The analyzer performs a read-only static scan. It never imports or executes target project source.

From the plugin root, run:

```bash
node scripts/analyze-three-project.mjs <project-root> \
  --output <output-model.json> \
  --report <coverage-report.md>
```

## Confirmed output

- Three.js presence and declared version.
- Browser entry points and likely runtime roots.
- Runtime event registrations consumed by production source.
- External assets referenced by production source or stored in conventional runtime asset directories.
- Known procedural asset systems such as worlds, enemy factories, weapon views, particles, and audio engines.
- Numeric fields declared through an explicit `DEFAULT_TUNING` plus `TUNING_SCHEMA` contract, but only when a production runtime member access consumes the field.
- Flat numeric defaults in a reachable `DEFAULTS`, `*_CONFIG`, `*_SETTINGS`, `*_TUNING`, `*_BALANCE`, or `*_PARAMS` object when production code reads the exact field. The current conservative adapter supports direct `ROOT.field` reads and `this.config.field` reads after `this.config = { ...ROOT }`. Every proposed binding is checked with the same exact-line patcher used by apply and preview.
- Named numeric gameplay constants such as `MAGAZINE` and `RELOAD_SECONDS` when later production code in the same reachable module reads them.

## Inferred output

- Worldview cards derived from the title and objective strings.
- Core-loop steps derived from detected player, weapon, enemy, mission, level, and boss systems.

These remain `inferred` until the user or a playtest confirms them. Partial coverage is intentional.

## Exclusions

- Tests, docs, tools, generated builds, dependencies, and screenshot-only evaluation material are not runtime sources.
- A numeric literal is not tunable merely because its name sounds relevant.
- A field path appearing only inside a string, schema, preset, or editor UI is not a runtime consumer.
- Procedural assets are preview slots, not automatically replaceable external files.

If neither supported pattern is found, return partial coverage and no automatic controls. Inline literals, computed values, nested presets, aliases, and values hidden behind unknown overrides need a project-specific adapter. Codex should inspect the gameplay path, introduce a small explicit config with real runtime reads and an exact source binding, then re-run analysis. Startup remains read-only; do not change the game merely to populate the UI.
