# Unified beginner workflow

## Start without asking the user to operate a terminal

1. Resolve the exact current game directory. Only Three.js is supported. If absent, explain the unsupported engine; do not silently create a fake model.
2. Run `node <plugin-root>/scripts/open-workbench.mjs <game-root> --no-open` using a persistent process session. It stores generated UI, drafts, proposals, history and candidates in `<game-root>/.game-tuning-workbench/` and does not edit game source at startup. `--output <directory>` is available when the game root is read-only; reuse a stable output directory so history survives.
3. Open the printed loopback URL in the app. The first screen must offer “先看看” and “允许修改”. Do not choose for the user.
4. Show the URL, not internal model IDs or JSON instructions. Keep the launch process alive. Repeat startup reuses a running session.

After analysis, inspect `analysis-report.md`. If the tuning count is zero, explain the concrete source shape: for example, gameplay numbers embedded in movement/combat logic, a nested preset, or an unconsumed config. Do not claim the current game can be tuned automatically. When the user asks Codex to adapt that game, first trace the exact runtime read, add a small explicit numeric config with safe ranges and a real consumer, and verify the model and exact-line apply path before offering controls. That source change follows the normal scoped proposal and confirmation flow.

## What the button actually does

“让 Codex 实施这份修改” prepares a bounded proposal. Exact numeric edits are prepared locally. Story/rule changes invoke the installed `codex exec` with `--ignore-user-config --sandbox read-only --ephemeral`, using the existing Codex login and a strict structured response schema. The worker receives only selected source text and the requested changes. It cannot write the game. It may use account quota, disclosed in the UI.

The backend checks file scope and unchanged numeric bindings, then shows a proposal. The user can run original/draft copies before confirming. Only “确认保存进游戏” writes approved files, rechecking their contents immediately before writing. Every apply has a durable receipt and recovery data. Incomplete writes are flagged on restart; do not silently retry an interrupted mutation.

## Verification and honest boundaries

Saving runs the game's `npm run build` when configured. Automatic evidence launches a temporary game copy, checks navigation, runtime errors and a visible canvas, attempts only a recognized start button, and captures a screenshot. This is a smoke test, not proof of combat, level completion, skill balance or the user's intended behavior. The user must check every behavior/exclusion item. No build script, missing browser, runtime errors or failed screenshot must remain visibly not-run/failed and cannot become verified.

For automatic evidence, install the plugin's optional dependency (`npm install --omit=dev` in the plugin root) and `npm run setup:browser` if needed. An installed Chrome can be used when the bundled browser is missing. In an app runtime with bundled Playwright, set `GTW_PLAYWRIGHT_MODULE` to the verified module path returned by the workspace dependencies tool. Never guess a machine-specific path or commit it in this plugin. Browser installation needs normal tool approvals, not user copy/paste.

Worldview images are explicitly references, not automatically replaced game content. Candidate PNG/JPG/WebP images can be uploaded and compared. Third-party image/model generation stays behind the provider contract until the user chooses a provider; generated-runtime assets require a real loader/runtime adapter. Do not claim an unimplemented model replacement happened.

## Recovery

Drafts live on the local server, not solely browser storage. A different port retains drafts if the output directory stays the same. Stale drafts are preserved and reported, not applied against changed source. Authorization is session-scoped and resets after restart. Old v0.3 browser drafts remain in the old page; the plugin cannot read a different origin's storage silently. Keep the old page available during upgrade if those drafts matter.

If Codex is not logged in, tell the user to sign into Codex; do not ask for an API key in the webpage. If the service stopped, reopen with the same entry. If source drift blocks an apply/undo, offer Codex help to inspect and merge, without automatically overwriting the new content.
