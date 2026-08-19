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
 * - The most recent workflow run (id, meta name, current phase, settled
 *   state) from `workflow/start` / `workflow/phase` / `workflow/end`. The
 *   workflow engine is a first-class activity in DSH that the capsule
 *   reports like any other busy signal.
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

/** Observed timeline facts for one subagent child. */
export interface TrackedSubagent {
  /** Host clock when `subagent/start` was observed. */
  startedAt?: number
  /** Host clock when `subagent/end` was observed. */
  finishedAt?: number
  /** Terminal stop reason carried by `subagent/end` (undefined if absent). */
  stopReason?: string
}

/** The most recent workflow run, as observed through the event feed. */
export interface TrackedWorkflow {
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
}

/** Process-local activity timeline for the pill panel. */
export class ActivityTracker {
  private readonly subagents = new Map<string, TrackedSubagent>()
  private workflow: TrackedWorkflow | null = null

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
    this.workflow = {
      id,
      name: str(meta, 'name') ?? id,
      phase: null,
      startedAt: Date.now(),
      settled: false,
    }
  }

  /** Observe one `workflow/phase` payload: refresh the matching run's phase. */
  onWorkflowPhase(info: unknown, title: unknown): void {
    const id = str(info, 'id')
    const phase = typeof title === 'string' && title !== '' ? title : null
    if (id === undefined || this.workflow === null || this.workflow.id !== id) return
    this.workflow.phase = phase
  }

  /** Observe one `workflow/end` payload: settle the matching run. */
  onWorkflowEnd(info: unknown, result: unknown): void {
    const id = str(info, 'id')
    if (id === undefined || this.workflow === null || this.workflow.id !== id) return
    this.workflow.settled = true
    this.workflow.stopReason = str(result, 'stopReason')
  }

  /** The tracked workflow run, or null. */
  workflowView(): TrackedWorkflow | null {
    return this.workflow
  }
}
