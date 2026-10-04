# Confirm and apply workbench

Use this stage only after the user has reviewed a complete draft ChangeSet. The browser never writes files directly; it talks to a loopback-only local service with an explicitly approved project root.

## Generate

Run from the plugin root:

```bash
node scripts/generate-apply-workbench.mjs <game-tuning-model.json> --output <workbench-directory>
```

An apply-mode workbench remains locked when served normally. This is the safe preview command:

```bash
node scripts/serve-workbench.mjs <workbench-directory> --host 127.0.0.1 --port 4179
```

Only after the user intends to apply this specific project's drafts, restart it with the exact analyzed root:

```bash
node scripts/serve-workbench.mjs <workbench-directory> --host 127.0.0.1 --port 4179 --allow-source-write <exact-project-root>
```

The server rejects source-write mode when the workbench is not in `apply` mode, the bind host is not loopback, or the approved root does not exactly match the analyzed model root.

## Confirmation sequence

1. The UI converts browser drafts to a `proposed` ChangeSet.
2. The service validates target IDs, source bindings, before-values, safe ranges, steps, exclusions, and current source text.
3. The service returns a short-lived proposal ID and digest without writing.
4. The UI displays the exact operations and requires a second explicit checkbox confirmation.
5. Apply requires both the proposal ID and digest in a same-origin JSON request.

Never collapse proposal and application into one click.

## Supported source shape

The first version applies finite numeric fields with an exact binding shaped like:

```text
ROOT.group.field + file + lineHint + access: editable
```

The source line must still contain the expected field and `before` value inside the expected `Object.freeze` group. Unsupported syntax or any drift stops the application and requires a fresh analysis. Do not search-and-replace a similar name elsewhere.

## Atomicity and evidence

- Resolve every file inside the exact approved project root and reject symlink escapes.
- Prepare and validate every patch before writing the first file.
- Write through same-directory temporary files and roll back already-written files if a later write fails.
- Save an application receipt and original file evidence under the workbench's hidden `.gtw-history` directory. Never serve that directory over HTTP.
- Update the generated model snapshot after source application so a refresh does not restore a stale baseline.
- Run the project's existing build script when detected. A successful build leaves the ChangeSet `applied`, not `verified`, until relevant gameplay is exercised.

## Verification workspace

The apply server exposes persistent receipts through `/api/receipts`. Each application generates a playtest checklist from the parameter's direct effects and the ChangeSet's excluded effects.

- Save partial check progress as `not-run`.
- A failed conclusion requires at least one failed check.
- A passed conclusion requires every check to pass, a non-failed build, and at least one PNG, JPEG, or WebP screenshot.
- Screenshot files live under the hidden receipt directory and are returned only through the validated receipt evidence endpoint.
- A verified receipt remains revertible.

Do not mark a receipt verified from build output alone.

## Revert

Revert uses the receipt's recorded `after -> before` operations. It rechecks that each current source value still equals `after`, then changes only those numeric bindings. Never restore an entire repository, reset a branch, or overwrite unrelated edits from the backup copy.

If the current value no longer matches `after`, stop with source drift and request a fresh analysis instead of forcing rollback.
