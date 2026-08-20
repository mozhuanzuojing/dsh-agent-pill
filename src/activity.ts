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

/** Accumulated adapter-reported token accounting for one session. */
export interface SessionUsage {
  /** Un-cached input tokens. */
  input: number
  /** Output tokens. */
  output: number
  /** Cache-read (cache hit) input tokens. */
  cacheRead: number
  /** Cache-write input tokens. */
  cacheWrite: number
}

/** One collected result-time file diff ({path, oldText|null, newText} + observed time). */
export interface FileDiffRecord {
  path: string
  /** Prior content, or null for a new file / an overwrite. */
  oldText: string | null
  /** Content after the change. */
  newText: string
  /** Host clock when the diff was observed. */
  ts: number
}

/** One activity-timeline event (the "eyes on the internals" feed). */
export interface ActivityEvent {
  kind: 'tool' | 'tool-done' | 'file' | 'workflow' | 'subagent' | 'goal'
  /** Host clock when the event was observed. */
  ts: number
  /** Short display text (tool name, file basename, phase title, …). */
  text: string
  /** Optional detail (path, duration, stop reason, operation). */
  detail?: string
  /** Merge count when the same file repeats within the merge window. */
  count?: number
}

/** Process-local activity timeline for the pill panel. */
export class ActivityTracker {
  /** Bounded history of the most recent workflow runs. */
  private static readonly WORKFLOW_HISTORY_LIMIT = 5
  /** Bounded activity-timeline length. */
  private static readonly TIMELINE_LIMIT = 40
  /** File events for the same path within this window merge into one entry. */
  private static readonly FILE_MERGE_MS = 60_000

  private readonly subagents = new Map<string, TrackedSubagent>()
  private readonly workflowRuns: TrackedWorkflowRun[] = []
  /** The run currently collecting (may be settled until replaced). */
  private activeRun: TrackedWorkflowRun | null = null
  /** How many `agent()` calls the run accepted (host-observed floor). */
  private activeRunAgentsStarted = 0
  /** The activity feed (newest first). */
  private readonly timeline: ActivityEvent[] = []

  /** Push one activity event (newest first, bounded). */
  private pushActivity(event: ActivityEvent): void {
    this.timeline.unshift(event)
    if (this.timeline.length > ActivityTracker.TIMELINE_LIMIT) {
      this.timeline.length = ActivityTracker.TIMELINE_LIMIT
    }
  }

  /** Observe one `subagent/start` payload (defensive). */
  onSubagentStart(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const entry = this.subagents.get(id) ?? {}
    entry.startedAt ??= Date.now()
    this.subagents.set(id, entry)
    this.pushActivity({ kind: 'subagent', ts: Date.now(), text: `subagent ${id.slice(0, 8)} started`, detail: str(info, 'provider') })
  }

  /** Observe one `subagent/end` payload (defensive). */
  onSubagentEnd(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const entry = this.subagents.get(id) ?? {}
    entry.finishedAt ??= Date.now()
    entry.stopReason = str(info, 'stopReason') ?? entry.stopReason
    this.subagents.set(id, entry)
    this.pushActivity({ kind: 'subagent', ts: Date.now(), text: `subagent ${id.slice(0, 8)} ended`, detail: entry.stopReason })
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
    this.pushActivity({ kind: 'workflow', ts: Date.now(), text: `workflow ${run.name} started` })
  }

  /** Observe one `workflow/phase` payload: refresh the matching run's phase. */
  onWorkflowPhase(info: unknown, title: unknown): void {
    const id = str(info, 'id')
    const phase = typeof title === 'string' && title !== '' ? title : null
    const run = id === undefined ? null : this.runOf(id)
    if (run === null) return
    run.phase = phase
    if (phase !== null) {
      this.pushActivity({ kind: 'workflow', ts: Date.now(), text: `workflow ${run.name} → ${phase}` })
    }
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
    this.pushActivity({ kind: 'workflow', ts: Date.now(), text: `workflow ${run.name} ended`, detail: run.stopReason })
  }

  /** Observe one `fs/observed` payload: attribute the file to the active run. */
  onFsObserved(target: unknown): void {
    const run = this.activeRun
    if (run === null || run.settled) return
    const displayPath = str(target, 'displayPath')
    if (displayPath === undefined) return
    if (!run.files.includes(displayPath)) run.files.push(displayPath)
    // Activity feed: merge repeats of the same path within the window.
    const now = Date.now()
    const newest = this.timeline[0]
    const base = displayPath.split(/[\\/]/).pop() ?? displayPath
    if (newest !== undefined && newest.kind === 'file' && newest.detail === displayPath && now - newest.ts < ActivityTracker.FILE_MERGE_MS) {
      newest.ts = now
      newest.count = (newest.count ?? 1) + 1
    } else {
      this.pushActivity({ kind: 'file', ts: now, text: base, detail: displayPath })
    }
  }

  // ── Per-session live surface: current tool call, token accounting, inbox ──

  private readonly toolCalls = new Map<string, { name: string; ts: number }>()
  /** In-flight tool (single-slot: DSH tools execute serially) for duration pairing. */
  private readonly currentTools = new Map<string, { name: string; startedAt: number }>()
  /** Recently completed tools: {name, durationMs}, newest first (bounded). */
  private readonly recentTools = new Map<string, Array<{ name: string; durationMs: number }>>()
  /** Result-time file diffs per session: path → latest record. */
  private readonly fileDiffs = new Map<string, FileDiffRecord>()
  private readonly usage = new Map<string, SessionUsage>()
  private readonly inboxCounts = new Map<string, number>()

  /**
   * Observe one `session/event` append: track the latest tool call (the
   * `tool/call` event carries the tool `name` directly; `tool/result`
   * closes the in-flight slot for duration pairing — the result event has
   * no callId at its top level, and DSH executes tools serially, so a
   * single slot is the right pairing model) and accumulate the step `usage`
   * accounting (the `assistant/message` event carries the step's `usage`
   * when the adapter reported it). Defensive reads throughout.
   */
  onSessionEvent(sessionId: string, event: unknown): void {
    if (typeof event !== 'object' || event === null) return
    const record = event as Record<string, unknown>
    const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : null
    if (data === null) return

    if (record.type === 'goal/change') {
      const operation = typeof data.operation === 'string' ? data.operation : undefined
      if (operation !== undefined) {
        this.pushActivity({ kind: 'goal', ts: Date.now(), text: `goal ${operation}` })
      }
      return
    }

    if (record.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : undefined
      if (name === undefined) return
      const now = Date.now()
      this.toolCalls.set(sessionId, { name, ts: now })
      this.currentTools.set(sessionId, { name, startedAt: now })
      this.pushActivity({ kind: 'tool', ts: now, text: `tool ${name}` })
      return
    }

    if (record.type === 'tool/result') {
      const inFlight = this.currentTools.get(sessionId)
      if (inFlight !== undefined) {
        const list = this.recentTools.get(sessionId) ?? []
        list.unshift({ name: inFlight.name, durationMs: Date.now() - inFlight.startedAt })
        this.recentTools.set(sessionId, list.slice(0, 5))
        this.currentTools.delete(sessionId)
        this.pushActivity({
          kind: 'tool-done',
          ts: Date.now(),
          text: `tool ${inFlight.name} done`,
          detail: `${Math.round((Date.now() - inFlight.startedAt) / 1000)}s`,
        })
      }
      // Result-time contextual diffs (dsh-tool-fs attaches { diffs: FileDiff[] }
      // as meta on write/edit results): { path, oldText|null, newText }.
      // Collected GLOBALLY by path (workflow subagent edits land in the child
      // session's event stream, but the panel reads them from the parent).
      const meta = data.meta
      const diffs = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>).diffs : undefined
      if (Array.isArray(diffs)) {
        for (const entry of diffs) {
          if (typeof entry !== 'object' || entry === null) continue
          const e = entry as Record<string, unknown>
          const path = typeof e.path === 'string' && e.path !== '' ? e.path : undefined
          const newText = typeof e.newText === 'string' ? e.newText : undefined
          if (path === undefined || newText === undefined) continue
          this.fileDiffs.set(path, {
            path,
            oldText: typeof e.oldText === 'string' ? e.oldText : null,
            newText,
            ts: Date.now(),
          })
        }
      }
      return
    }

    if (record.type === 'assistant/message') {
      const usage = data.usage
      if (typeof usage !== 'object' || usage === null) return
      const u = usage as Record<string, unknown>
      const current = this.usage.get(sessionId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      // TokenUsage field names (dsh-llm): *Tokens suffixes.
      const fields: Array<[keyof SessionUsage, string]> = [
        ['input', 'inputTokens'],
        ['output', 'outputTokens'],
        ['cacheRead', 'cacheReadTokens'],
        ['cacheWrite', 'cacheWriteTokens'],
      ]
      for (const [field, tokenKey] of fields) {
        const value = u[tokenKey]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          current[field] += value
        }
      }
      this.usage.set(sessionId, current)
    }
  }

  /** Observe one `agent/inbox/*` event: keep a per-session queued-message count. */
  onInboxEvent(sessionId: string | undefined, kind: 'inserted' | 'claimed' | 'discarded'): void {
    if (sessionId === undefined) return
    const next = (this.inboxCounts.get(sessionId) ?? 0) + (kind === 'inserted' ? 1 : -1)
    this.inboxCounts.set(sessionId, Math.max(0, next))
  }

  /** The latest observed tool-call name for one session (undefined when none). */
  toolCallOf(sessionId: string): string | undefined {
    return this.toolCalls.get(sessionId)?.name
  }

  /** When the current tool started (host clock; undefined when none). */
  toolSinceOf(sessionId: string): number | undefined {
    return this.currentTools.get(sessionId)?.startedAt
  }

  /** Recently completed tools for one session (newest first, bounded). */
  recentToolsOf(sessionId: string): Array<{ name: string; durationMs: number }> {
    return [...(this.recentTools.get(sessionId) ?? [])]
  }

  /** Accumulated adapter-reported token usage for one session. */
  usageOf(sessionId: string): SessionUsage {
    return { ...(this.usage.get(sessionId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }
  }

  /** Result-time file diffs (global by path, newest record per path). */
  fileDiffsOf(): FileDiffRecord[] {
    return [...this.fileDiffs.values()]
  }

  /** The activity feed (newest first, deep-copied). */
  timelineOf(): ActivityEvent[] {
    return this.timeline.map((event) => ({ ...event }))
  }

  /** Queued (inbox) message count for one session. */
  inboxCountOf(sessionId: string): number {
    return this.inboxCounts.get(sessionId) ?? 0
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
