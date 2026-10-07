# ADR-0002: Plugin distribution and user-scoped agent identity

- **Status:** Accepted (2026-10-07)
- **Decides:** Epic #8 scope additions (#7 rewrite, #5 extension, #9)
- **Extends:** ADR-0001

## Context

pm-autopilot is currently consumed via `omp plugin link /path/to/checkout` — a dev-loop-only binding that requires the source checkout on every machine. ADR-0001's identity design (ticket #7) wrote GitHub App credentials into the **repo-root** `.env.local`, which binds the agent identity to a single project. The goal: install once, reuse the `pm-autopilot[bot]` identity across all projects.

Mechanics verified against omp (`omp://plugin-manager-installer-plumbing.md`):

- `omp plugin install github:<user>/<repo>` installs from git via `bun install` into `~/.omp/plugins` (user scope by default); `omp plugin upgrade` re-resolves the recorded ref; `omp plugin link` stays the dev loop.
- Manifest = `package.json#omp` (already present: `tools: "./src/tools.ts"`); TS loads directly.
- `omp plugin config` settings persist in `omp-plugins.lock.json`, but there is **no documented injection of settings into custom-tool factories** — plugin code cannot portably read them.

Terminology: the identity is a **GitHub App**, not an OAuth App. Only a GitHub App's installation (server-to-server) tokens produce the `pm-autopilot[bot]` author badge; OAuth user-to-server tokens always attribute to the human.

## Decision

1. **Distribution: git-installable package** — `omp plugin install github:Samuka007/pm-autopilot` is the primary path (no registry dependency); npm publish is an optional follow-up. Package hygiene ticket: #9. `link` remains documented for development.
2. **Credential store: plugin-owned, user-level** — `~/.config/pm-autopilot/credentials.json`, mode 0600, XDG_CONFIG_HOME-aware. Keys: `app_id`, `private_key` (PEM) or `private_key_path`, optional `default_installation_id`.
3. **Resolution order: process env → user store → repo `.env.local`.** Env keeps CI/herdr-lane overrides; user store is the cross-project default; repo `.env.local` remains a per-project escape hatch.
4. **Installation resolved per target repo at runtime** — `PM_GITHUB_INSTALLATION_ID` overrides; otherwise `GET /repos/{owner}/{repo}/installation`, cached in-process per repo. One App, credentials stored once, many repos.

## Alternatives considered

- **`omp plugin config set` as the credential store**: first-class CLI and project-override semantics, but settings are not injected into custom-tool factories (undocumented/brittle lockfile reads would be required). Rejected as the store; revisit if omp adds a documented settings API for tools.
- **Per-repo `.env.local` only** (ADR-0001 original): simplest, but exactly the per-project binding this ADR removes. Kept only as the lowest-priority fallback.
- **npm-only distribution**: adds a publish step and registry dependency before the plugin is installable at all; git spec works today. Rejected as primary.

## Consequences

- Ticket #7 is rewritten (user-level store target + post-write verification), #5 gains per-repo installation resolution, #9 covers packaging/distribution.
- The onboarding flow becomes: install plugin (any project) → run `scripts/onboard_github_app.mjs` once → identity works everywhere the App is installed.
- Secret surface: one 0600 file per machine; `.env.local` no longer required for identity.
