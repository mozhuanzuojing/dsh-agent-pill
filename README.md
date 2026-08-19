# dsh-agent-pill

DSH (DeepSeek Harness) web plugin: a ZCode-style agent activity pill (top-right status capsule) plus a popover summary panel, toggled with **Ctrl+Alt+P**.

- **host half**: aggregates the current conversation's Goal / Subagents / Agent status / workflow runs / background jobs and exposes a fenced JSON API (`/pill/api`) with full control verbs.
- **client half**: top-right floating status capsule + popover panel (goal card, workflow history with steps and observed files, subagent tree, job list with output/kill, usage).

## UI behavior

- **Tooltip-style popover (v0.4.0)**: the panel expands as a light popover anchored to the capsule — no fixed right-side drawer. It flips across all four viewport edges to stay fully on screen, clamps to `min(360px, viewport)` wide and ~70vh tall with inner scrolling, and closes on outside click, Esc, or the shortcut.
- **Collapsible sections (v0.4.0)**: Goal / Agent / Subagents / Jobs / Usage headers toggle their content; collapsed state is remembered in `localStorage`.
- **Draggable capsule**: drag the pill to any screen edge; the seat persists in `localStorage` across reloads and stays clamped to the viewport on window resize.
- **Auto light/dark theme**: the palette is driven by CSS variables that follow the DSH theme signal (`<body data-ds-dark-theme>`), so the capsule and panel switch between the white and the dark ("moon night") scheme instantly — including `system` mode following the OS.
- **Shortcut**: Ctrl+Alt+P toggles the panel (click also works).
- **Goal card** shows the objective, phase, rounds, and **elapsed time** (ZCode-style), with a **rounds progress bar** (`roundsStarted / maxGoalRounds`) and the activation state.
- **Capsule summary (v0.3.0)**: the pill shows the goal's elapsed time plus live badges — running subagents, running jobs, an active **workflow run** (`wf`, with the current phase in the tooltip), and **failed jobs** (red).
- **Workflow history (v0.4.0)**: the most recent workflow runs (bounded ring of 5) are listed under Agent. Each run expands to show its **steps** (each `agent()` call: seq, label, phase, outcome) and the **files observed** while the run was active (from the host's `fs/observed` feed, deduped, attributed at run level — the feed has no session dimension). Settled runs keep their details until replaced.
- **Jobs as step entries (v0.4.0)**: each background job is rendered as a single step entry (status, output summary, timing) — jobs have no structured steps, so no file extraction is attempted.
- **Subagent tree (v0.3.0)**: descendants are indented by depth, and each row shows its **run duration** and **terminal stop reason** (failed settles render red) — timestamps come from the host's `subagent/start` / `subagent/end` observation, since the durable listing carries none.
- **Usage section (v0.3.0)**: when the host mounts `tokenMeter`, the panel shows the session's current token pressure, surface, and signed surface delta (measured at most every 10s).

## Install

```sh
dsh plugin --profile web add dsh-agent-pill
# restart the profile (the web composition disables host-side HMR)
```

## Features

| Section | Data source | Control verbs |
|---------|-------------|---------------|
| Goal | `goal/change` session-event projection replay + live append feed (last-wins fold) | `goal.pause` / `goal.resume` / `goal.complete` / `goal.clear` (CAS `{id, revision}`, requires a live agent) |
| Subagents | `ctx.subagents.listDescendants` (durable tree, live-preferred) + process-local `subagent/start` / `subagent/end` timestamps | `subagent.interrupt` (human-parent authority; cancels a continuable child's current turn) |
| Agent | `ctx.agents.get(id)?.status` + `agent/status` events (`idle` / `running`) | read-only |
| Workflow | `workflow/start` / `workflow/phase` / `workflow/agent-start` / `workflow/agent-end` / `workflow/end` events (bounded history of 5 runs, each with steps); files from the global `fs/observed` feed while a run is active | read-only |
| Jobs | `ctx.jobs.list(caller)` + `onJobsChanged` invalidation (single step entry per job) | `jobs.kill` (registry stock API); `jobs.output` (event replay, never consumes the model's cursor) |
| Usage | `ctx.tokenMeter.measure(session)` (throttled to 10s) | read-only |

## API routes

All routes pass the browser-trust fence (loopback Host or `trustedHosts`; cross-site requests refused) and answer `{ok, value}` / `{ok:false, error:{code,message}}`.

- `POST /pill/api/state` — `{sessionId}` → aggregated snapshot (goal / agent / subagents / jobs / services)
- `POST /pill/api/goal.pause|resume|complete|clear` — `{sessionId, id, revision}`
- `POST /pill/api/subagent.interrupt` — `{sessionId, childId}`
- `POST /pill/api/jobs.output` — `{sessionId, id}`
- `POST /pill/api/jobs.kill` — `{sessionId, id, reason?}`

## Build from source

```sh
pnpm install
pnpm build        # tsc host → tsc client → tsdown (lib/index.js + lib/client.js)
```

- host half: plain ESM (`lib/index.js`); runtime `@deepseek-ai/*` peers resolve from the deployment's module fallback.
- client half: `window.__ModuleLoader__.load({id:'dsh-agent-pill', factory})` protocol artifact (`lib/client.js`); platform modules external, everything else inlined.

## Mount manually (without npm)

Create a junction from your profile's `plugins/` directory to this package, then append to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: agent-pill
      name: 'dsh-agent-pill'   # or a relative path like './plugins/dsh-agent-pill'
```

> A patch entry must be an id-targeted override or an `insert` list — a bare `- name: <package>` row is skipped by `applyEntryPatches`.

> Restart the DSH profile after any `cordis.patch.yml` / bundles change (the web composition disables host-side HMR); client bundle changes only need a hard browser refresh.

## License

MIT
