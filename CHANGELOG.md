# Changelog

All notable changes to CoordClaw are documented here.

Versioning convention: the git tag always matches `controlpanel/web/package.json` version (e.g. `v2.9.0`). See that file for the current public version.

## [2.9.0] - 2026-08-01

First public baseline release.

### Changed
- **plugins/coordcenter**: unified config file read/write through the new `config-store` module, centralizing access across modules.
- **docs**: embedded 7 README illustrations (zh/en) — org relation, message loop, team configs (`RULE.md` / `teamsoul.md` / `team.json`), and the agent structured work log.
- **docs**: added an Observability section (local BPE token estimation for models that don't return `usage`) and clarified the three-config hierarchy.

### Chore
- ignore `wiki-draft/` in `.gitignore`.
