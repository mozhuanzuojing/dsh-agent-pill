/**
 * dsh-agent-pill activity tracker (process-local).
 *
 * Turns the host event feed into the timeline facts the panel surfaces:
 *
 * - Per-child subagent start/finish timestamps with terminal stop reasons.
 *   The durable subagent listing carries no timestamps, so the pill records
 *   its own observation of `subagent/start` / `subagent/end` — the panel can
 *   show how long each child has been running and how it settled (fresh
 *   process: recent children simply show no duration yet).
 * - Workflow runs (from `workflow/start` / `workflow/phase` /
 *   `workflow/agent-start` / `workflow/agent-end` / `workflow/end`): a
 *   bounded history of the most recent runs, each with its phase, its
 *   `agent()` call steps (seq, label, phase, child session, outcome), and
 *   the set of files observed while the run was active (fed by the global
 *   `fs/observed` emit feed — the files are attributed at run level because
 *   that feed carries no session dimension).
 * - Background jobs are surfaced by the jobs service itself; the panel
 *   renders each job as a single step entry (no structured steps exist).
 *
 * Everything is best-effort: payloads are read defensively (they may come
 * from a host with a newer service contract) and a failed read never throws
 * into the event dispatch.
 */

/** Defensive field reader: string field or undefined. */
function str(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field !== '' ? field : undefined
}

/** Defensive field reader: number field or undefined. */
function num(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

/** Observed timeline facts for one subagent child. */
export interface TrackedSubagent {
  /** Host clock when `subagent/start` was observed. */
  startedAt?: number
  /** Host clock when `subagent/end` was observed. */
  finishedAt?: number
  /** Terminal stop reason carried by `subagent/end` (undefined if absent). */
  stopReason?: string
}

/** One `agent()` call step inside a workflow run. */
export interface TrackedWorkflowStep {
  /** 1-based sequence number of the call within the run. */
  seq: number
  /** Display label (the `label` option, or a prompt snippet). */
  label: string
  /** The phase this agent belongs to (the `phase` option, else the current `phase()` title). */
  phase?: string
  /** The child agent's id on the subagent seam. */
  childId?: string
  /** How the call settled: 'completed' | 'failed' | 'cancelled' (present after workflow/agent-end). */
  outcome?: string
}

/** One workflow run with its collected details. */
export interface TrackedWorkflowRun {
  id: string
  /** The run's meta block name (kebab-case workflow name). */
  name: string
  /** Latest `phase()` title, or null before the first phase. */
  phase: string | null
  /** Host clock when `workflow/start` was observed. */
  startedAt: number
  /** Whether `workflow/end` has been observed. */
  settled: boolean
  /** Settlement stop reason (present iff settled). */
  stopReason?: string
  /** The `agent()` call steps observed so far, in call order. */
  steps: TrackedWorkflowStep[]
  /** Files observed while the run was active (`fs/observed` displayPath, deduped). */
  files: string[]
}

/** Process-local activity timeline for the pill panel. */
export class ActivityTracker {
  /** Bounded history of the most recent workflow runs. */
  private static readonly WORKFLOW_HISTORY_LIMIT = 5

  private readonly subagents = new Map<string, TrackedSubagent>()
  private readonly workflowRuns: TrackedWorkflowRun[] = []
  /** The run currently collecting (may be settled until replaced). */
  private activeRun: TrackedWorkflowRun | null = null
  /** How many `agent()` calls the run accepted (host-observed floor). */
  private activeRunAgentsStarted = 0

  /** Observe one `subagent/start` payload (defensive). */
  onSubagentStart(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const entry = this.subagents.get(id) ?? {}
    entry.startedAt ??= Date.now()
    this.subagents.set(id, entry)
  }

  /** Observe one `subagent/end` payload (defensive). */
  onSubagentEnd(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const entry = this.subagents.get(id) ?? {}
    entry.finishedAt ??= Date.now()
    entry.stopReason = str(info, 'stopReason') ?? entry.stopReason
    this.subagents.set(id, entry)
  }

  /** Tracked facts for one child id (empty record when never observed). */
  subagentOf(id: string): TrackedSubagent {
    return this.subagents.get(id) ?? {}
  }

  /** Observe one `workflow/start` payload (defensive). */
  onWorkflowStart(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const meta = typeof info === 'object' && info !== null
      ? (info as Record<string, unknown>).meta
      : undefined
    const run: TrackedWorkflowRun = {
      id,
      name: str(meta, 'name') ?? id,
      phase: null,
      startedAt: Date.now(),
      settled: false,
      steps: [],
      files: [],
    }
    this.activeRun = run
    this.activeRunAgentsStarted = 0
    this.workflowRuns.unshift(run)
    if (this.workflowRuns.length > ActivityTracker.WORKFLOW_HISTORY_LIMIT) {
      this.workflowRuns.length = ActivityTracker.WORKFLOW_HISTORY_LIMIT
    }
  }

  /** Observe one `workflow/phase` payload: refresh the matching run's phase. */
  onWorkflowPhase(info: unknown, title: unknown): void {
    const id = str(info, 'id')
    const phase = typeof title === 'string' && title !== '' ? title : null
    const run = id === undefined ? null : this.runOf(id)
    if (run === null) return
    run.phase = phase
  }

  /** Observe one `workflow/agent-start` payload: append a step to the run. */
  onWorkflowAgentStart(info: unknown, agent: unknown): void {
    const runId = str(info, 'id')
    const run = runId === undefined ? null : this.runOf(runId)
    if (run === null || run.settled) return
    const seq = num(agent, 'seq') ?? this.activeRunAgentsStarted + 1
    const label = str(agent, 'label')
    if (label === undefined) return
    run.steps.push({
      seq,
      label,
      phase: str(agent, 'phase') ?? run.phase ?? undefined,
      childId: str(agent, 'childId'),
    })
    this.activeRunAgentsStarted = Math.max(this.activeRunAgentsStarted, seq)
  }

  /** Observe one `workflow/agent-end` payload: mark the step's outcome. */
  onWorkflowAgentEnd(info: unknown, agent: unknown): void {
    const runId = str(info, 'id')
    const run = runId === undefined ? null : this.runOf(runId)
    if (run === null) return
    const seq = num(agent, 'seq')
    const outcome = str(agent, 'outcome')
    if (seq === undefined || outcome === undefined) return
    const step = run.steps.find((candidate) => candidate.seq === seq)
    if (step !== undefined) step.outcome = outcome
  }

  /** Observe one `workflow/end` payload: settle the matching run. */
  onWorkflowEnd(info: unknown, result: unknown): void {
    const id = str(info, 'id')
    const run = id === undefined ? null : this.runOf(id)
    if (run === null) return
    run.settled = true
    run.stopReason = str(result, 'stopReason')
  }

  /** Observe one `fs/observed` payload: attribute the file to the active run. */
  onFsObserved(target: unknown): void {
    const run = this.activeRun
    if (run === null || run.settled) return
    const displayPath = str(target, 'displayPath')
    if (displayPath === undefined || run.files.includes(displayPath)) return
    run.files.push(displayPath)
  }

  /** The workflow run history (most recent first, deep-copied). */
  workflowHistory(): TrackedWorkflowRun[] {
    return this.workflowRuns.map((run) => ({
      ...run,
      steps: run.steps.map((step) => ({ ...step })),
      files: [...run.files],
    }))
  }

  /** Find a tracked run by id (active first, then history). */
  private runOf(id: string): TrackedWorkflowRun | null {
    if (this.activeRun !== null && this.activeRun.id === id) return this.activeRun
    const found = this.workflowRuns.find((run) => run.id === id)
    return found ?? null
  }
}
