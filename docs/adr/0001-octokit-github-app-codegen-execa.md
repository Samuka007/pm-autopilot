# ADR-0001: Octokit transport, GitHub App identity, codegen types, execa processes

- **Status:** Accepted (2026-10-07)
- **Decides:** Epic #8 (tickets #3, #4, #5, #6, #7)

## Context

The repo's GitHub-facing layers are hand-rolled with zero runtime dependencies:

| Concern | Today | Evidence |
|---|---|---|
| GitHub transport | bare `fetch` → `api.github.com/graphql`, `Bearer` header, no retry/throttle/typed errors | `src/core.ts:488-517` |
| Auth | `GH_TOKEN` env → `gh auth token` fallback; no agent identity | `src/core.ts:473-477` |
| GraphQL typing | string documents + `Record<string, unknown>` results | `src/core.ts:610-647` |
| Child processes | `execFileSync` / detached `spawn` | `src/core.ts:476-485`, `src/tools.ts:99-103` |

Drivers: (1) published issues must be attributable to an agent identity, not the human account; (2) rate-limit and error handling should be library-grade; (3) every mutation is currently typecheck-blind.

## Decision

1. **Transport: `octokit`** (core + `plugin-retry` + `plugin-throttling`). `defaultGql` delegates to `octokit.graphql`. The `_inject` test seam stays authoritative: injected `gql` wins, so tests remain offline.
2. **Identity: `@octokit/auth-app`** when `PM_GITHUB_APP_ID` + key env are set (installation token, auto-minted/refreshed); otherwise the existing token chain. Attribution fact: only installation (server-to-server) tokens produce the `pm-autopilot[bot]` author badge; user tokens (PAT / `gh auth token` / OAuth) always show the human user. No code path may rely on the display name — the credential is the identity.
3. **Typing: graphql-codegen** against the SDL shipped by `@octokit/graphql-schema`; generated artifacts committed; CI gates codegen drift (`git diff --exit-code`).
4. **Processes: `execa` v9** for `git`, `gh auth token`, and the detached omp spawn, preserving fire-and-forget semantics and the injection seams.

## Alternatives considered

- **genql** (fluent typed client from schema): low maintenance activity; replaces the documents we deliberately keep small and reviewed. Rejected.
- **gql.tada**: type-safety without build artifacts, but binds editor/type-server performance to a 10k+-type schema and yields no committed artifacts. Codegen's committed output is boring and diffable. Rejected.
- **Machine-user account** instead of a GitHub App: needs an org seat, no `[bot]` badge, token = full account surface vs least-privilege App permissions (`metadata: read`, `issues: write`, `projects: write`). Rejected.
- **Status quo** (keep hand-rolled fetch + gh fallback): cheapest, but leaves retry/throttle/attribution/typing unsolved — the explicit user decision was to adopt professional libraries.

## Consequences

- Runtime deps added: `octokit`, `@octokit/auth-app`, `execa`. Dev deps: `@graphql-codegen/*`, `@octokit/graphql-schema`. Codegen is a new build step; CI gains a drift gate.
- All test seams (`injected.gql`, `injected.runGit`, judge fetch) must keep working; `makeGql(fetch?)` gives unit tests direct access to the real Octokit path via a stub fetch.
- Without the App envs, behavior is byte-compatible with today; App identity is opt-in per environment.
- Onboarding friction shifts from "create an App in Settings UI" to a manifest-flow script (#7).
