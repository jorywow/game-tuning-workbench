---
name: game-tuning-workbench
description: Open a beginner-friendly tuning workbench for the current Three.js game from a single request such as “打开这个游戏的调优工作台”. Automatically analyze, launch and open the unified browse, draft, confirm, verify and undo flow. Also use for source-backed game tuning, story/rule change proposals, preview evidence and asset candidate comparison.
---

# Game Tuning Workbench

Create a source-backed tuning layer for the current game. Do not present inferred design intent as confirmed runtime behavior.

## Scope gate

- Confirm the project imports `three` directly or through a clearly identifiable Three.js runtime module.
- If Three.js is absent, report the unsupported target and stop before generating a workbench.
- Treat UI frameworks and build tools as project details, not additional supported game engines.
- Preserve existing movement, combat, level, rendering, and asset-loading behavior unless the user approves a scoped ChangeSet.

## Workflow

### Default: one-sentence startup

Read [novice-workflow.md](references/novice-workflow.md). Resolve the current game directory from the task workspace; never pick an unrelated prior game. If the workspace is this plugin, ask which game to open rather than analyzing the plugin as a game.

When the app dependency-discovery tool is available, find and verify its bundled Playwright module and pass that path as `GTW_PLAYWRIGHT_MODULE`; otherwise set up the optional browser dependency described in the reference. Do not make a novice install it manually or silently claim evidence when unavailable.

Run `node <plugin-root>/scripts/open-workbench.mjs <game-root> --no-open` as a persistent local process. This single entry analyzes Three.js, generates the unified workbench, chooses a free loopback port and reuses a live session. Open the printed URL using the app browser/open-in-Codex tool. Do not merely give the user a terminal command. If app browser tooling is unavailable, omit `--no-open` to use the OS browser.

The first-use UI presents only “先看看” and “允许修改”. The latter authorizes this game for this server session, not unrestricted agent access. Every actual source apply still requires a proposal digest and explicit confirmation. Do not pre-authorize or click confirmation for a user's real game unless they explicitly asked you to apply that exact change.

Use the unified entry for new work. The legacy three generator scripts below exist only for compatibility and diagnostics; do not ask a novice to select a technical mode.

### Source-backed implementation and compatibility

1. Inspect package metadata, entry points, runtime modules, configuration, assets, and available build or browser checks.
2. Build one `GameTuningModel` from traceable evidence. Use the read-only analyzer for the first pass, then review its limitations. Mark every conclusion as `confirmed`, `inferred`, or `missing`.
   If there are no numeric controls, identify the game's actual value ownership. The analyzer now accepts a narrow set of consumed flat config objects as well as the explicit schema. For inline or computed values, explain the needed game-specific adapter; never invent sliders. When the user requests adaptation, prepare that source change for confirmation before treating it as tunable.
3. Generate the unified workbench using the default entry above. Verify story, gameplay, tuning and assets; leave first-use permission selection to the user.
4. Give each editable parameter one owner and one real source binding. A visible control without a runtime consumer is not tunable.
5. Keep preview edits in draft state. Do not rewrite source while the user is dragging controls or comparing alternatives.
6. Before source application, use the runtime preview bridge when the project exposes a `dev` or `start` script. Compare the original A instance with the draft B instance; both must run from temporary copies and the analyzed source files must retain their original fingerprints.
7. Convert accepted drafts into a ChangeSet that lists direct effects, dependencies, excluded effects, verification, rollback, and an application strategy for every operation. Keep `automatic` numeric operations separate from `codex-assisted` worldview, gameplay, and asset operations.
8. Apply only after explicit confirmation. The legacy numeric engine accepts only automatic finite numeric operations. In the unified flow the button invokes a read-only Codex proposal worker: no manual JSON handoff. Source writes happen only through the guarded transaction service after confirmation. Do not weaken its sandbox or expand its selected file scope to force a proposal through.
9. Run the relevant build checks, then use the verification workspace to complete every expected-effect and excluded-effect check. Require screenshot evidence before marking an automatically applied ChangeSet verified.
10. Revert from the recorded receipt when the user rejects the result. The unified service restores recorded files only while they exactly match its saved output; later changes must block restoration instead of being overwritten. Preserve unrelated edits and explain when a manual merge is needed.

The product sequence is fixed: `draft preview -> confirm apply -> verify or revert`. Do not silently skip a state.

## References

- Read [model-contract.md](references/model-contract.md) when creating, updating, or reviewing a game model.
- Read [three-project-analyzer.md](references/three-project-analyzer.md) before running or interpreting the static analyzer.
- Read [readonly-workbench.md](references/readonly-workbench.md) before generating or previewing the read-only UI.
- Read [draft-workbench.md](references/draft-workbench.md) before enabling parameter controls or generating a draft ChangeSet.
- Read [apply-workbench.md](references/apply-workbench.md) before starting the source-write service or confirming an application.
- Read [runtime-preview.md](references/runtime-preview.md) before starting, interpreting, or stopping an A/B runtime preview.
- Read [changeset-lifecycle.md](references/changeset-lifecycle.md) before applying or reverting a workbench draft.
- Read [content-changesets.md](references/content-changesets.md) before implementing worldview, gameplay-rule, or asset operations exported by the workbench.
- Read [asset-provider-contract.md](references/asset-provider-contract.md) only when defining or using image/model generation adapters.

Canonical machine-readable contracts are in `../../schemas/`. From this skill directory, validate examples and contract invariants with:

```bash
node ../../scripts/validate-contracts.mjs
```
