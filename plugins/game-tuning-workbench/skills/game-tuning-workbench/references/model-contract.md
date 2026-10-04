# Game tuning model contract

Use `schemas/game-tuning-model.schema.json` as the canonical shape.

## Evidence boundary

Every worldview card, gameplay rule, tuning parameter, and asset slot must cite one or more evidence IDs.

- `confirmed`: directly supported by code, configuration, assets, or a user confirmation.
- `inferred`: a plausible interpretation that still needs confirmation.
- `missing`: the project does not currently define enough information.

Never use inferred content as the source binding for an automatic edit.

## Ownership and isolation

Each editable target has a stable ID. Each tuning parameter additionally has exactly one `ownerId`, one editable `sourceBinding`, and one `previewBinding`.

Effects are explicit:

- `direct`: behavior intentionally changed by the target.
- `indirect`: known dependent behavior that may also change.
- `excluded`: behavior that must remain unchanged.

If one source value controls multiple independent player-facing outcomes, model it as coupled and warn the user. Do not pretend it is independently tunable.

Asset slots refer to stable asset IDs. Replacing an asset must preserve gameplay bindings unless the ChangeSet separately declares a gameplay operation.

## Three.js boundary

Record the detected Three.js version, game entry points, runtime roots, rendering systems, and project limitations. Do not classify Vite, React, physics libraries, or post-processing packages as game engines.

Runtime behavior is confirmed only when a source consumer exists. Build success alone does not prove that a control changes the playable result.
