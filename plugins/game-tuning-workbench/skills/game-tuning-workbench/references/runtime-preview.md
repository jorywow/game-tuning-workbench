# Runtime A/B preview

Use the runtime preview before source application when a draft needs real game-feel comparison.

## Safety model

- The analyzed project root remains read-only during preview.
- The service records hashes for every bound source file before startup.
- It creates two system-temporary project copies while excluding `.git`, `node_modules`, build output, and workbench history.
- Existing `node_modules` is linked read-only into each temporary copy when available.
- A keeps the current source values. B patches only the draft operations inside its temporary copy.
- Both copies run the project's existing `dev` or `start` script on separate loopback ports.
- Stop both child processes and remove the temporary directory when preview ends or the workbench service shuts down.

## User flow

1. Create one or more browser drafts in the tuning view.
2. Start A/B preview. Starting again replaces the prior temporary session.
3. Repeat the same short interaction in A and B. Parameters marked as restart-dependent require restarting the game inside both variants.
4. If the draft changes, use **Update draft preview**; the running B instance is a frozen snapshot of the previous draft.
5. Stop and clean up before applying source changes. The application path also stops an active preview automatically.

## Verification boundary

A running page proves that both real Three.js applications loaded. It does not by itself prove that the new feel is desirable. Record the comparison in the verification workspace after application. If the source fingerprint changes during preview, report it as external source drift; the preview service must never claim responsibility or overwrite the change.
