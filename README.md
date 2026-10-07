# pm-autopilot

PM state machine for agent fleets: **board-truth dispatch gates, guarded board
writes, drift audit, evidence-bound closeouts** — packaged as an omp
custom-tool family (`pm_lane` / `pm_apply` / `pm_audit` / `pm_walk_ledger` /
`pm_walk`) plus a `%load`-able AP core (`src/core.ts`) for the omp eval JS
kernel.

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
| `pm_walk_ledger` | `AP.walkDue` / `AP.walkDone` / `AP.walkLedger` | 走查挂账 ledger (#391): register {ticket, due, face}, settle with evidence, read events + active set. Overdue = audit rule 8 → board flips red (Wait for user). |
| `pm_walk` | `AP.walk` | Acceptance probe (#392): walks a real page — console/page errors, failed requests, selector assertions, screenshot — and writes `.pm-walk/` evidence with a sha256 anchor for the `source:walk` closeout gate (#390). Read-only against the board. |

Retired (#460, user ruling 2026-10-07): the #240 browser-lease ledger and its
tool pair (`pm_release` / `pm_ledger`), audit rule 6, and `AP.lane`'s
auto-lease — per-agent headless browsers left nothing to contend for.
`.pm-leases.jsonl` survives only as a frozen historical ledger.

Bundles one task-agent def: `agents/pm-guard.md` (board guardian; same
guarded-write discipline).

## Install

```sh
# user scope (all projects)
omp plugin link /path/to/pm-autopilot

# then verify
omp plugin list
```

In any omp session the five tools are then discoverable without any import —
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
| `JEV_API_KEY` | gitignored `.env.local` at the repo root | Judge (intake/file classification) only — the five tools never touch jev. Real-call smoke skips itself without a key. |
| `PM_WORKTREE_ROOT` | `~/.herdr/worktrees` | Worktree-root seam (#396): re-points packet paths AND `AP.lane`'s `git worktree add` target at a non-herdr provisioning backend without code changes. |
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
- **Append-only ledgers, gitignored.** Closeouts and walk deferrals live in
  `.pm-*.jsonl` files that are never committed.
- **No secrets in code.** `GH_TOKEN` / `JEV_API_KEY` come from env or a
  gitignored `.env.local`. Judge replies classify only — nothing auto-writes;
  the gate decides who reads the result.

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
  src/tools.ts        # the five custom tools + detached-omp fallback
  src/host-types.ts   # structural omp CustomToolAPI types (no omp dep needed)
  agents/pm-guard.md  # task-agent def (board guardian)
  test/               # L1: core / tools / walk suites + shared fixtures
```

The two #396 decoupling seams, for the record: `PM_WORKTREE_ROOT` (worktree
backend root, default `~/.herdr/worktrees`) and the classify prompt naming
`PM_REPO`'s repo instead of a hardcoded name.
