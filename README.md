# pm-autopilot

PM state machine for agent fleets: **board-truth dispatch gates, guarded board
writes, drift audit, resource leases, evidence-bound closeouts** — packaged as
an omp custom-tool family (`pm_lane` / `pm_apply` / `pm_audit` / `pm_release` /
`pm_ledger` / `pm_walk_ledger` / `pm_walk`) plus a `%load`-able AP core
(`src/core.ts`) for the omp eval JS kernel.

Extracted verbatim from `Samuka007/cloudflare-agent-project` `plugins/pm-harness`
(#396), carrying the full lineage #131 → #270 → #277 → #299 → #391 → #392 →
#393. The conductor layer for multi-agent fleets: the GitHub Projects V2 board
is the ONLY truth; every entry point re-derives everything from the board per
turn and keeps zero resident state.

## The tools

| Tool | Wraps | What it does |
| --- | --- | --- |
| `pm_lane` | `AP.lane` | Gate check (open ∧ Todo ∧ no open blockers) → worktree provision → lane spawn → `blockedBy` edges materialized with the dispatch (#393) → guarded board flip to In Progress. Dry-run default. |
| `pm_apply` | `AP.apply` | The ONLY board write path: preflight diff → batched guarded writes with per-batch re-verify; drift withholds remaining batches. Dry-run default. |
| `pm_audit` | `AP.audit` | Board-vs-reality drift reconcile (read-only); walk-due rule 8 always armed from the repo ledger; prose dependencies without a `blockedBy` edge (#393, rule 9, advisory); returns `pm_apply`-ready repair mutations. |
| `pm_release` | `AP.release` | Browser-lease release (CDP tab/thread discipline) in the append-only ledger. |
| `pm_ledger` | `AP.ledger` | Lease ledger read: full event log + replayed active set. |
| `pm_walk_ledger` | `AP.walkDue` / `AP.walkDone` / `AP.walkLedger` | 走查挂账 ledger (#391): register {ticket, due, face}, settle with evidence, read events + active set. Overdue = audit rule 8 → board flips red (Wait for user). |
| `pm_walk` | `AP.walk` | Acceptance probe (#392): walks a real page — console/page errors, failed requests, selector assertions, screenshot — and writes `.pm-walk/` evidence with a sha256 anchor for the `source:walk` closeout gate (#390). Read-only against the board. |

Bundles one task-agent def: `agents/pm-guard.md` (board guardian; same
guarded-write discipline).

## Install

```sh
# user scope (all projects)
omp plugin link /path/to/pm-autopilot

# then verify
omp plugin list
```

In any omp session the seven tools are then discoverable without any import —
model-callable directly, callable from the eval kernel as
`await tool.pm_lane(310, {}, { confirm: true })`, or mounted as `xd://pm_*`
under `tools.xdev`.

The AP core also loads standalone in the eval JS kernel:

```js
%load "/path/to/pm-autopilot/src/core.ts"
// → installs globalThis.AP (also exported as a named export for vitest)
```

External dependencies: `gh` CLI with `GH_TOKEN` (or an existing `gh auth
token`); `herdr` only for the default worktree provisioning convention; omp for
the lane spawn transport (kernel `globalThis.agent` or the detached-omp
fallback — see below).

## Configuration — the full env surface

Nothing is required: every variable has a default and the tools refuse loudly
when the default target is not readable. To adopt onto your own board, set at
minimum `PM_REPO` + `PM_PROJECT_ID`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PM_REPO` | `Samuka007/cloudflare-agent-project` | `owner/name` of the audited repo + board. Also injected into the jev classify prompt (#396 — the prompt names YOUR repo, no hardcoding). |
| `PM_PROJECT_ID` | `PVT_kwHOAvgCqs4Blk19` | GitHub Projects V2 GraphQL id. Field/option ids are ALWAYS resolved live at runtime — only this container id is configured. |
| `GH_TOKEN` | `gh auth token` fallback | GitHub token for GraphQL reads/writes. |
| `PM_GITHUB_APP_ID` | unset | GitHub App id (#5). Set together with `PM_GITHUB_APP_PRIVATE_KEY`/`PM_GITHUB_APP_KEY_PATH` to route all board writes through an installation token (`pm-autopilot[bot]` attribution — see "Agent identity"). |
| `PM_GITHUB_APP_PRIVATE_KEY` | unset | App private key, PEM. May be single-line with `\n` escapes. Mutually exclusive with `PM_GITHUB_APP_KEY_PATH`. |
| `PM_GITHUB_APP_KEY_PATH` | unset | Path to the App private key PEM file (alternative to inlining it). |
| `PM_GITHUB_INSTALLATION_ID` | unset | Overrides per-repo installation resolution (#5): when set, every repo uses this installation id without the lookup. |
| `JEV_API_KEY` | gitignored `.env.local` at the repo root | Judge (intake/file classification) only — the seven tools never touch jev. Real-call smoke skips itself without a key. |
| `PM_WORKTREE_ROOT` | `~/.herdr/worktrees` | Worktree-root seam (#396): re-points packet paths AND `AP.lane`'s `git worktree add` target at a non-herdr provisioning backend without code changes. |
| `PM_LEASES_PATH` | `.pm-leases.jsonl` at the package root | Browser-lease ledger (append-only, gitignored). |
| `PM_CLOSEOUTS_PATH` | `.pm-closeouts.jsonl` at the package root | Closeout evidence ledger. |
| `PM_WALKS_PATH` | `.pm-walks.jsonl` at the package root | Walk-deferral (走查挂账) ledger. |
| `PM_LANE_NO_DETACH` | unset | `=1` disables the detached-omp spawn fallback, restoring the transport-missing contract. |
| `PM_WALK_CDP_HTTP` | unset | Forces the raw-CDP walk path session-wide (normally a per-call `cdpHttp` opt-in). |

Reproducible from zero (fresh machine, no defaults in env):

```sh
export PM_REPO="you/your-repo"
# copy the "id" (the PVT_… GraphQL id) of your board from:
gh project list --owner you --format json
export GH_TOKEN="$(gh auth token)"
export PM_PROJECT_ID="PVT_yourBoardId"
omp plugin link /path/to/pm-autopilot
```

## Board conventions (documented, not coded)

The core expects these consumer-side conventions; they are vocabulary, not
logic, so they are documented here rather than parameterized:

- Projects V2 single-select fields named exactly **`Status`** and
  **`Priority`**.
- The six-state Status vocabulary: `Backlog` / `Todo` / `In Progress` /
  `Wait for user` / `Done` / `Canceled` (closed states only ever written to
  closed issues — enforced, not advisory).
- The **`closeoutGated`** label plus the evidence-typed closeout ledger
  (`source:walk` for product-surface acceptance; CI alone is rejected for UI
  deliverables, #390).
- Labels/milestones/statuses are resolved live from the repo at runtime;
  unknown vocabulary is a preflight error (closed-vocabulary invariant).
- The tracker-schema axes doc (`docs/agents/tracker-schema.md` in the consumer
  repo) is referenced by name in classify prompts — ship an equivalent schema
  doc in your repo.

## Agent identity (GitHub App)

Attribution is credential-determined: whoever owns the token authors the
issues. Only a GitHub App's **installation (server-to-server) token** produces
the `pm-autopilot[bot]` author badge; user tokens (PAT, `gh auth token`,
OAuth user-to-server) always attribute to the human. No code path relies on
the display name — the credential IS the identity (#5, ADR-0001 §2).

Credential resolution order (ADR-0002 §3):

1. **Process env** — `PM_GITHUB_APP_ID` + `PM_GITHUB_APP_PRIVATE_KEY` (PEM) or
   `PM_GITHUB_APP_KEY_PATH`. The CI/herdr-lane override surface; repo
   `.env.local` is deliberately NOT read for App credentials.
2. **User store** — `~/.config/pm-autopilot/credentials.json` (mode 0600,
   `XDG_CONFIG_HOME`-aware), written once by the onboarding flow and reused
   across every project. Keys: `app_id`, `private_key` (PEM) or
   `private_key_path` (relative paths anchor at the store's directory),
   optional `default_installation_id` (legacy alias:
   `first_installation_id`).
3. **Neither** → the existing chain (`GH_TOKEN` → `gh auth token`), unchanged.

A partially-configured identity (id without key, malformed store) throws —
it never silently degrades to user-token writes, which would misattribute
them to the human account.

Installation tokens resolve **per target repo** (`PM_REPO`):
`GET /repos/{owner}/{repo}/installation` (app-JWT Bearer) is looked up and
cached in-process per repo; when the lookup finds no installation there
(HTTP 404 — App not on that repo), the store's `default_installation_id`
stands in. `PM_GITHUB_INSTALLATION_ID` overrides the resolution entirely.
`@octokit/auth-app` mints, caches, and re-mints the ~1h tokens transparently,
so long PM sessions never ride an expired Bearer.

Required App permissions (no webhooks): `metadata: read`, `issues: write`,
`projects: write` on the selected repositories.

### Onboarding — one command, once per machine (#7)

```sh
node scripts/onboard_github_app.mjs        # --force replaces a different App's store
```

Plain node, zero extra deps — it runs before the plugin itself is trusted
infrastructure. The script:

1. Prints the manifest URL
   (`https://github.com/settings/apps/new?state=…`); open it and approve App
   creation.
2. GitHub redirects to a placeholder page ending in `?code=<code>` — paste
   that code at the prompt (no local callback server involved).
3. Exchanges the code for the App credentials and writes the **machine-level**
   store `~/.config/pm-autopilot/credentials.json` (0600, dir 0700,
   `XDG_CONFIG_HOME`-aware) with `app_id`, `private_key`,
   `default_installation_id` — reused by every project; a run leaves git
   status untouched.
4. Verifies the write end to end by minting one installation token through
   the written credentials and reporting success/failure (the PEM and tokens
   are never printed).

Re-running the script with the same App updates the store in place; a store
belonging to a different App is only replaced with `--force`. *(User-level
manual smoke: this flow touches github.com and your home directory — run it
once yourself; the automated suite covers it offline with injected
fetch/stream stubs.)*

## Quickstart — one PM turn

```js
%load "/path/to/pm-autopilot/src/core.ts"

const snap = await AP.snapshot();               // board + open issues, one pass
const due = AP.dispatchable(snap);              // pure predicate over the snapshot
const packets = AP.dispatchPackets(due, snap);  // worktree plan + lane context + budget
// hand each packet to a lane (herdr/task); then mark the wave In Progress:
await AP.apply(due.map((t) => ({ op: "setStatus", number: t.number, value: "In Progress" })));
// ^ DRY-RUN default: prints the preflight diff, writes nothing.
await AP.apply(<same mutations>, { confirm: true }); // guarded batched writes
```

Full dispatch through the gate (worktree + spawn + guarded flip in one call):

```js
await AP.lane(number, {}, { confirm: true });
```

As model tools, the same flow is: `pm_audit` (read the drift) → `pm_apply`
(read the preflight diff) → `pm_apply { confirm: true }` (write) — the
pm-guard agent def encodes exactly this discipline.

## Security model

- **Dry-run default.** Every mutating entry point (`apply`, `lane`, closeout
  writes) is a no-write plan/diff until `{ confirm: true }` is passed —
  explicitly, per call, by a reader of the previous dry-run output.
- **Preflight diff.** Writes resolve into a plan first; the plan prints as a
  diff. Unknown labels/milestones/statuses and closed-state Statuses on open
  tickets are preflight errors — nothing partially applies.
- **Per-batch re-verify + drift withhold.** After each written batch the board
  is re-read; any drift withholds the remaining batches. Blind retry is never
  the recovery — investigate, repair via `pm_audit`, re-run.
- **Evidence-bound closeouts.** The closeout gate rejects `source:ci` for
  product-surface acceptance (#390); UI evidence must carry a `pm_walk` report
  anchor (`.pm-walk/…/report.json` + sha256).
- **Append-only ledgers, gitignored.** Leases, closeouts, and walk deferrals
  live in `.pm-*.jsonl` files that are never committed; lease discipline
  (named tab + thread prefix + release obligation) is enforced at dispatch.
- **No secrets in code.** `GH_TOKEN` / `JEV_API_KEY` come from env or a
  gitignored `.env.local`; GitHub App credentials (#5) come from env or the
  user-scoped 0600 store (`~/.config/pm-autopilot/credentials.json`) — never
  from git. Judge replies classify only — nothing auto-writes; the gate
  decides who reads the result.

## Spawn transport ladder (`pm_lane`)

1. `AP.registerSpawn(fn)` override (tests / custom weaves)
2. eval-kernel `globalThis.agent` (the omp kernel recipe)
3. Detached fallback: a detached headless `omp -p <lane context> --cwd
   <worktree>` — stdout/stderr append to `<worktree>/.pm-lane.log`; resumable
   via `omp --resume`. Returns pid + log path as the dispatch receipt.
   Escape hatch: `PM_LANE_NO_DETACH=1` restores the transport-missing
   contract.

## AP.walk — the acceptance probe surface

```js
const report = await AP.walk(
    "https://staging.example/settings/plugins",
    [{ selector: "[data-testid]", atLeast: 1 }],
    { tabName: "l392-walk" });
report.ok;                 // checks passed ∧ zero console-level errors
report.evidence.anchor;    // ".pm-walk/…/report.json sha256=…" — AP.closeout's
                           //   evidence field consumes this (source:walk)
```

Transport ladder: the eval-kernel `browser` global (managed headless Chromium)
is the preferred surface; explicit `cdpHttp` opts into a raw-CDP bridge for
Access-gated faces needing a human-login profile — never a silent default;
`allowFetchFallback` degrades to fetch + raw-HTML checks and the report says
`consoleCapture: "unavailable"` so a gate can reject it for UI evidence.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # L1 suites: core / tools / walk — zero network;
                 # the real-call jev smoke skips without JEV_API_KEY
```

Layout:

```
pm-autopilot/
  package.json        # omp manifest: tools → ./src/tools.ts
  src/core.ts         # AP core (#131, relocated #270, extracted #396)
  src/walk.ts         # AP.walk probe surface (#392): facade → raw-CDP → fetch
  src/tools.ts        # the seven custom tools + detached-omp fallback
  src/host-types.ts   # structural omp CustomToolAPI types (no omp dep needed)
  agents/pm-guard.md  # task-agent def (board guardian)
  test/               # L1: core / tools / walk suites + shared fixtures
```

The two #396 decoupling seams, for the record: `PM_WORKTREE_ROOT` (worktree
backend root, default `~/.herdr/worktrees`) and the classify prompt naming
`PM_REPO`'s repo instead of a hardcoded name.
