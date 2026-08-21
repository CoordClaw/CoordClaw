# Changelog

All notable changes to CoordClaw are documented here.

Versioning convention: the git tag always matches `controlpanel/web/package.json` version (e.g. `v2.9.0`). See that file for the current public version.

## [2.10.5] - 2026-08-21

### Fixed
- **plugins/coordcenter · session-key migration**: fixed the whitelist-update issue that occurred when migrating a project and creating a new project `sessionKey`. The tracked-session whitelist is now correctly refreshed on project migration so new sessions are properly included.

### Changed
- **controlpanel/web · token stats**: enhanced token statistics to break down consumption by `agentId`, giving per-agent visibility into token usage.
- **controlpanel/web**: public version bumped to 2.10.5 (coordcenter internal `19.81.0`).

## [2.10.4] - 2026-08-20

### Fixed
- **plugins/coordcenter · LLM error handling**: enhanced LLM error-code detection; `team.json` now supports custom error-code key names, improving compatibility across more openclaw variants.
- **docs**: fixed an incorrect script name referenced in README (zh/en).

### Changed
- **controlpanel/web**: public version bumped to 2.10.4 (coordcenter internal `19.74.0`).

## [2.10.3] - 2026-08-16

### Fixed
- **controlpanel/web · message-triggered dispatch**: fixed a bug where a message sent from the web control panel (a human user action) falsely triggered the "previous round task unfinished, please continue" notification. Web-sent messages are user-initiated and are no longer subject to previous-task-completion checks.

### Changed
- **teamstemplate · project charter**: refined the template team's project charter so the long-term goal stays more stable.
- **controlpanel/web**: public version bumped to 2.10.3 (coordcenter internal `19.70.0`).

## [2.10.2] - 2026-08-12

### Changed
- **plugins/coordcenter · task tracking**: adopt the member standard-action execution database (task_progress.db) to determine whether an agent has completed its current round of tasks; group-chat feedback is now used only as a fallback mechanism.
- **controlpanel/web**: public version bumped to 2.10.2.

### Fixed
- **plugins/coordcenter · force-route**: fixed a bug where force-route unconditionally triggered the unfinished-task notification even when there was no unfinished task.

## [2.10.1] - 2026-08-11

### Added
- **plugins/coordcenter · message-routing**: when a member fails to complete its current single task, automatically reduce the number of members woken up for dispatch, preventing the task from blocking on a specific member. This feature is toggleable via a `team.json` config switch.

### Changed
- **start.cjs**: refactored into a single isomorphic `BUILD_TARGETS` loop (plugin + web share scan/install/build primitives); `isSource` now explicitly excludes `.d.ts` to remove the latent "recompile every startup" loop if `declaration` output ever lands in the source tree; `runNpm` uses `shell: true` for reliable `npm.cmd` resolution on Windows and consistent `/bin/sh` on Linux/macOS; dropped an unused `version` constant.
- **controlpanel/web**: skills handler (`skills.ts`), i18n strings (`i18n-strings.ts`), and chat UI (`index.html`, `app-main.js`, `api.js`) updates; public version bumped to `2.10.1`.
- **plugins/coordcenter** (internal `19.60.0`): message-routing (`cache/manager.ts`, `dispatch.ts`, `state-machine.ts`), session-snapshot (`persistence.ts`, `snapshot-events.ts`), `environment.ts`, `shared/types.ts`, `index.ts`, and `openclaw.plugin.json` adjustments; added `shared/plugin-version.ts` and `scripts/`.
- **docs**: refreshed README zh/en; added `HUSTAIL.png` diagram under `docs/readme_png/{zh,en}`.
- **teamstemplate**: updated `team.json` for zh/en and their `CoordClawAITeam_*` variants.

## [2.10.0] - 2026-08-10

### Added
- **teamstemplate**: member standard-action execution status database (`task_progress.db`) recording T1–T5 progress, used to verify whether standard actions are completed.
- **coordcenter**: default-on single-round session check (`checktaskfeedback`, enabled by default in `team.json`). When an agent stops early without completing its standard actions (T4/T5), CoordClaw restarts a reminder to finish them — primarily guarding against repeated tool calls blowing the token budget and LLM abnormal termination. Reminder copy reworded to a "resume and complete" directive.
- **plugins/coordcenter · message-routing**: extracted the routing core into `dispatch-queue.ts` as framework-free pure functions (`buildDispatchQueue`, `compareFirstUnreadAt`), enabling standalone unit tests; added `test/dispatch-queue.test.ts` and a `test` npm script.
- **plugins/coordcenter · shared primitives (L0)**: added `session-api.ts` (process-level session API singleton, lifted out of `token-stats/pool.ts`) and `session-key.ts` (single source of truth for SessionKey create / existence / reconcile).

### Changed
- **controlpanel/web**: reworked the chat module — optimized tool-call folding logic in the chat UI (`chat.js`); bumped the public version to `2.10.0`.
- **plugins/coordcenter**: `project-create` / `project-switch` / `team-delete` now route through the shared `session-key` reconcile, removing duplicated private copies; `token-stats/pool.ts` uses the shared session-api singleton.

## [2.9.0] - 2026-08-01

First public baseline release.

### Changed
- **plugins/coordcenter**: unified config file read/write through the new `config-store` module, centralizing access across modules.
- **docs**: embedded 7 README illustrations (zh/en) — org relation, message loop, team configs (`RULE.md` / `teamsoul.md` / `team.json`), and the agent structured work log.
- **docs**: added an Observability section (local BPE token estimation for models that don't return `usage`) and clarified the three-config hierarchy.

### Chore
- ignore `wiki-draft/` in `.gitignore`.
