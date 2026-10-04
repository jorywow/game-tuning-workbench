# Content ChangeSets

Use this reference for `edit-worldview`, `edit-gameplay`, and `replace-asset` operations in ChangeSet schema `0.2.0`.

## Strategy boundary

Each operation declares one application strategy:

- `automatic` + `local-apply-engine`: only a confirmed finite numeric parameter with an exact editable binding may use this path.
- `codex-assisted` + `codex`: semantic intent that requires source inspection, implementation judgment, or a provider result.

Never send a Codex-assisted operation to the local apply engine. A read-only source binding is evidence about where to investigate, not permission to replace text at that location.

## Worldview operation

Treat `after.title` and `after.body` as the desired player-facing world description. Inspect every evidence reference and the listed source binding. Change only the smallest narrative, presentation, scene, or content definitions needed to express that intent.

- Do not modify gameplay rules, tuning parameters, or linked assets unless separate operations name those targets.
- If the card is inferred and the project has no player-facing narrative surface, stop and explain what new surface would need to be added.
- Preserve the recorded `before` content as the rollback reference and update the analyzed model after implementation.

## Gameplay operation

Treat `trigger`, `condition`, `result`, and `playerFeedback` as a behavioral contract. Inspect the rule owner, event registration, consumers, and related tuning dependencies before editing.

- Do not mechanically rename event strings based on the prose.
- Prefer the smallest code path that realizes the new rule.
- Do not tune adjacent values or change another rule unless another operation names it.
- Add or update focused checks for the new trigger, condition, result, and feedback where the project supports them.

## Asset operation

`after.generationRequest` is provider-neutral. When `selectedOutput` is `null`, the operation is a candidate-generation brief only and must not replace the current asset.

After a provider returns a candidate:

1. record the local candidate path and output metadata;
2. validate MIME type, dimensions, transparency, model format, animations, and polygon budget when declared;
3. preserve gameplay bindings and usage paths;
4. show or describe the candidate for explicit confirmation;
5. replace only the named asset slot; and
6. build, preview, and retain the original asset for scoped rollback.

Provider credentials and provider-specific job data never belong in the ChangeSet.

## Completion

After Codex-assisted implementation, report the exact files changed for each operation, the checks run, unresolved warnings, and how to restore the recorded `before` state. Re-run the analyzer and regenerate the workbench so browser-local drafts do not remain attached to a stale model snapshot.
