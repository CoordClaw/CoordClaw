# Changelog

All notable changes to CoordClaw are documented here.

Versioning convention: the git tag always matches `controlpanel/web/package.json` version (e.g. `v2.9.0`). See that file for the current public version.

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
