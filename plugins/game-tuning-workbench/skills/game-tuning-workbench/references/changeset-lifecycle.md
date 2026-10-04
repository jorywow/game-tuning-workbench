# ChangeSet lifecycle

Use `schemas/change-set.schema.json` as the canonical shape.

## States

1. `draft`: preview-only values; source is untouched.
2. `proposed`: operations and impact are complete and awaiting confirmation.
3. `applied`: confirmed operations were written to source.
4. `verified`: build and relevant browser checks passed.
5. `failed`: application or verification failed.
6. `reverted`: the recorded before-values were restored and checked.

Only an explicit user confirmation can move a proposed ChangeSet to applied. A failed ChangeSet may be corrected in a new draft or reverted; do not silently broaden its operations.

## Atomicity

One ChangeSet should represent one user-visible intention. Every operation records `before`, `after`, the stable target ID, and the expected source binding. Before applying, verify that the current source still matches `before`; otherwise stop and regenerate the proposal.

The impact section must name:

- expected direct effects;
- dependent targets;
- excluded effects that must remain stable;
- unresolved warnings.

## Verification and rollback

Use the project's existing checks where possible. At minimum, validate the build and exercise the affected behavior in a browser when claiming a playable change. Record evidence paths or concise observations.

Rollback restores recorded before-values, not a broad repository reset. Preserve unrelated user changes.
