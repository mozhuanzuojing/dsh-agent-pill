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

/** ZCode 7-color palette (grey/red/orange/yellow/green/blue/purple) for subagent identity dots. */
const SUBCUT_CONSISTENT_PALETTE = ['#8b8b9c', '#e05a5a', '#d98a3b', '#d9a13b', '#3fb96a', '#5a9cf0', '#a37de8']

/** First file basename for a turn with files but no meta (defensive). */
function firstFileName(files: Map<string, FileDiffRecord>): string {
  const first = files.values().next().value as FileDiffRecord | undefined
  return first !== undefined ? (first.path.split(/[\\/]/).pop() ?? first.path) : 'turn'
}

/** Extract the first text snippet from a message payload (defensive). The
 *  user/message data IS the message ({role, content}), while assistant/message
 *  wraps it as {message}: accept both shapes. */
function textOfMessage(data: Record<string, unknown>): string {
  const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : data
  const content = Array.isArray(message.content) ? message.content : null
  if (content === null) return ''
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      const text = b.text.trim().replace(/\s+/g, ' ')
      return text.slice(0, 80)
    }
  }
  return ''
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

/** One turn's meta facts aggregated from the session event stream (ZCode round view). */
export interface TurnMeta {
  /** Turn number (1-based; the session event stream's `turn` field). */
  turn: number
  /** Round title: the user message text snippet, or the first tool name. */
  title: string
  /** Number of tool calls observed during this turn. */
  tools: number
  /** Host clock when `turn/end` was observed, or null while open. */
  endedAt: number | null
  /** End reason kind from `turn/end` data (`completed|aborted|blocked|error`), or null. */
  endReason: string | null
}

/** One wire turn row: meta + the files that turn handled (files may be absent). */
export interface TurnWireView {
  turn: number
  title: string
  tools: number
  endedAt: number | null
  endReason: string | null
  files: FileDiffRecord[]
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
  /** Bounded per-session activity-timeline length. */
  private static readonly TIMELINE_LIMIT = 40
  /** File events for the same path within this window merge into one entry. */
  private static readonly FILE_MERGE_MS = 60_000
  /** Bounded per-session turn history (turn → files). */
  private static readonly TURN_LIMIT = 10

  private readonly subagents = new Map<string, TrackedSubagent>()
  private readonly workflowRuns: TrackedWorkflowRun[] = []
  /** The run currently collecting (may be settled until replaced). */
  private activeRun: TrackedWorkflowRun | null = null
  /** How many `agent()` calls the run accepted (host-observed floor). */
  private activeRunAgentsStarted = 0
  /** Per-session activity feeds (newest first). */
  private readonly timelines = new Map<string, ActivityEvent[]>()
  /** Per-session turn → path → latest diff. */
  private readonly turnFiles = new Map<string, Map<number, Map<string, FileDiffRecord>>>()
  /** Per-session turn → turn meta (title, tools, end reason), bounded by TURN_LIMIT. */
  private readonly turnMeta = new Map<string, Map<number, TurnMeta>>()
  /** Per-session pending approval requests ({id, toolName}); cleared by approval/decided. */
  private readonly pendingApprovals = new Map<string, { id: string; toolName: string; ts: number }>()
  /** Per-session open turn (set by turn/start, cleared by turn/end): user/message
   *  carries NO turn field (its data IS the message), so title attribution uses
   *  the stream order. */
  private readonly openTurn = new Map<string, number>()
  /** Last session that ran a tool (fs events without a session dimension land here). */
  private lastActiveSession: string | null = null

  /** Push one activity event (newest first, bounded) for one session. */
  private pushActivity(sessionId: string, event: ActivityEvent): void {
    const feed = this.timelines.get(sessionId) ?? []
    feed.unshift(event)
    if (feed.length > ActivityTracker.TIMELINE_LIMIT) {
      feed.length = ActivityTracker.TIMELINE_LIMIT
    }
    this.timelines.set(sessionId, feed)
  }

  /** Push an event to the last session that ran a tool (sessionless events). */
  private pushGlobalActivity(event: ActivityEvent): void {
    if (this.lastActiveSession === null) return
    this.pushActivity(this.lastActiveSession, event)
  }

  /** Observe one `subagent/start` payload (defensive). */
  onSubagentStart(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const entry = this.subagents.get(id) ?? {}
    entry.startedAt ??= Date.now()
    this.subagents.set(id, entry)
    this.pushGlobalActivity({ kind: 'subagent', ts: Date.now(), text: `subagent ${id.slice(0, 8)} started`, detail: str(info, 'provider') })
  }

  /** Observe one `subagent/end` payload (defensive). */
  onSubagentEnd(info: unknown): void {
    const id = str(info, 'id')
    if (id === undefined) return
    const entry = this.subagents.get(id) ?? {}
    entry.finishedAt ??= Date.now()
    entry.stopReason = str(info, 'stopReason') ?? entry.stopReason
    this.subagents.set(id, entry)
    this.pushGlobalActivity({ kind: 'subagent', ts: Date.now(), text: `subagent ${id.slice(0, 8)} ended`, detail: entry.stopReason })
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
    this.pushGlobalActivity({ kind: 'workflow', ts: Date.now(), text: `workflow ${run.name} started` })
  }

  /** Observe one `workflow/phase` payload: refresh the matching run's phase. */
  onWorkflowPhase(info: unknown, title: unknown): void {
    const id = str(info, 'id')
    const phase = typeof title === 'string' && title !== '' ? title : null
    const run = id === undefined ? null : this.runOf(id)
    if (run === null) return
    run.phase = phase
    if (phase !== null) {
      this.pushGlobalActivity({ kind: 'workflow', ts: Date.now(), text: `workflow ${run.name} → ${phase}` })
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
    this.pushGlobalActivity({ kind: 'workflow', ts: Date.now(), text: `workflow ${run.name} ended`, detail: run.stopReason })
  }

  /** Observe one `fs/observed` payload: feed the timeline unconditionally,
   *  and attribute the file to the active workflow run when one is running. */
  onFsObserved(target: unknown): void {
    const displayPath = str(target, 'displayPath')
    if (displayPath === undefined || this.lastActiveSession === null) return
    // Timeline: all file activity counts ("eyes on the internals"), scoped to
    // the last session that ran a tool (the feed has no session dimension).
    const now = Date.now()
    const base = displayPath.split(/[\\/]/).pop() ?? displayPath
    const feed = this.timelines.get(this.lastActiveSession) ?? []
    const newest = feed[0]
    if (newest !== undefined && newest.kind === 'file' && newest.detail === displayPath && now - newest.ts < ActivityTracker.FILE_MERGE_MS) {
      newest.ts = now
      newest.count = (newest.count ?? 1) + 1
    } else {
      this.pushActivity(this.lastActiveSession, { kind: 'file', ts: now, text: base, detail: displayPath })
    }
    // Run attribution: only while a workflow run is active.
    const run = this.activeRun
    if (run === null || run.settled) return
    if (!run.files.includes(displayPath)) run.files.push(displayPath)
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
        this.pushActivity(sessionId, { kind: 'goal', ts: Date.now(), text: `goal ${operation}` })
      }
      return
    }

    // ── Round (turn) meta aggregation: title from the user message, tool
    // count from tool/call, end reason from turn/end. This is the host-side
    // data for the ZCode-style "round view" (one pill sees the task arc).
    if (record.type === 'turn/start') {
      const turn = num(data, 'turn')
      if (turn === undefined) return
      this.openTurn.set(sessionId, turn)
      const byTurn = this.turnMeta.get(sessionId) ?? new Map<number, TurnMeta>()
      if (!byTurn.has(turn)) byTurn.set(turn, { turn, title: '', tools: 0, endedAt: null, endReason: null })
      this.turnMeta.set(sessionId, byTurn)
      this.trimTurns(sessionId, byTurn)
      return
    }

    if (record.type === 'user/message') {
      // data IS the user message (no turn wrapper); attribute by stream order.
      const turn = num(data, 'turn') ?? this.openTurn.get(sessionId)
      if (turn === undefined) return
      const byTurn = this.turnMeta.get(sessionId)
      if (byTurn === undefined || !byTurn.has(turn)) return
      const meta = byTurn.get(turn)!
      if (meta.title === '') meta.title = textOfMessage(data)
      return
    }

    if (record.type === 'turn/end') {
      const turn = num(data, 'turn')
      if (turn === undefined) return
      this.openTurn.delete(sessionId)
      const byTurn = this.turnMeta.get(sessionId)
      const meta = byTurn?.get(turn)
      if (meta !== undefined) {
        meta.endedAt = Date.now()
        const reason = typeof data.reason === 'object' && data.reason !== null
          ? str(data.reason, 'kind')
          : undefined
        meta.endReason = reason ?? null
      }
      return
    }

    if (record.type === 'approval/asked') {
      const id = str(data, 'id')
      if (id === undefined) return
      this.pendingApprovals.set(sessionId, {
        id,
        toolName: str(data, 'toolName') ?? 'operation',
        ts: Date.now(),
      })
      this.pushActivity(sessionId, { kind: 'tool', ts: Date.now(), text: 'approval requested', detail: str(data, 'toolName') })
      return
    }

    if (record.type === 'approval/decided') {
      const id = str(data, 'id')
      if (id === undefined) return
      const pending = this.pendingApprovals.get(sessionId)
      if (pending !== undefined && pending.id === id) this.pendingApprovals.delete(sessionId)
      return
    }

    if (record.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : undefined
      if (name === undefined) return
      const now = Date.now()
      this.lastActiveSession = sessionId
      this.toolCalls.set(sessionId, { name, ts: now })
      this.currentTools.set(sessionId, { name, startedAt: now })
      const turn = num(data, 'turn')
      if (turn !== undefined) {
        const byTurn = this.turnMeta.get(sessionId)
        const meta = byTurn?.get(turn)
        if (meta !== undefined) {
          meta.tools += 1
          if (meta.title === '') meta.title = name
        }
      }
      this.pushActivity(sessionId, { kind: 'tool', ts: now, text: `tool ${name}` })
      return
    }

    if (record.type === 'tool/result') {
      const inFlight = this.currentTools.get(sessionId)
      if (inFlight !== undefined) {
        const list = this.recentTools.get(sessionId) ?? []
        list.unshift({ name: inFlight.name, durationMs: Date.now() - inFlight.startedAt })
        this.recentTools.set(sessionId, list.slice(0, 5))
        this.currentTools.delete(sessionId)
        this.pushActivity(sessionId, {
          kind: 'tool-done',
          ts: Date.now(),
          text: `tool ${inFlight.name} done`,
          detail: `${Math.round((Date.now() - inFlight.startedAt) / 1000)}s`,
        })
      }
      // Result-time contextual diffs (dsh-tool-fs attaches { diffs: FileDiff[] }
      // as meta on write/edit results): { path, oldText|null, newText }.
      // Collected GLOBALLY by path (workflow subagent edits land in the child
      // session's event stream, but the panel reads them from the parent),
      // and aggregated per session × turn for the instruction-tail view.
      const turn = num(data, 'turn')
      const meta = data.meta
      const diffs = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>).diffs : undefined
      if (Array.isArray(diffs)) {
        const perTurn = turn === undefined ? null : this.turnFiles.get(sessionId) ?? new Map<number, Map<string, FileDiffRecord>>()
        for (const entry of diffs) {
          if (typeof entry !== 'object' || entry === null) continue
          const e = entry as Record<string, unknown>
          const path = typeof e.path === 'string' && e.path !== '' ? e.path : undefined
          const newText = typeof e.newText === 'string' ? e.newText : undefined
          if (path === undefined || newText === undefined) continue
          const record: FileDiffRecord = {
            path,
            oldText: typeof e.oldText === 'string' ? e.oldText : null,
            newText,
            ts: Date.now(),
          }
          this.fileDiffs.set(path, record)
          if (perTurn !== null && turn !== undefined) {
            const byPath = perTurn.get(turn) ?? new Map<string, FileDiffRecord>()
            byPath.set(path, record)
            perTurn.set(turn, byPath)
            if (perTurn.size > ActivityTracker.TURN_LIMIT) {
              const oldest = perTurn.keys().next().value as number | undefined
              if (oldest !== undefined) perTurn.delete(oldest)
            }
            this.turnFiles.set(sessionId, perTurn)
          }
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

  /** The activity feed for one session (newest first, deep-copied). */
  timelineOf(sessionId: string): ActivityEvent[] {
    return (this.timelines.get(sessionId) ?? []).map((event) => ({ ...event }))
  }

  /** Turns with meta and/or files for one session (oldest first). A turn with
   *  neither meta nor files is omitted (exists-only philosophy). */
  turnsOf(sessionId: string): TurnWireView[] {
    const perTurn = this.turnFiles.get(sessionId)
    const meta = this.turnMeta.get(sessionId)
    const keys = new Set<number>()
    for (const [turn] of perTurn ?? []) keys.add(turn)
    for (const [turn] of meta ?? []) keys.add(turn)
    if (keys.size === 0) return []
    return [...keys]
      .sort((a, b) => a - b)
      .map((turn) => {
        const m = meta?.get(turn)
        const files = perTurn?.get(turn)
        if (m === undefined && (files === undefined || files.size === 0)) return null
        return {
          turn,
          title: (m?.title !== undefined && m.title !== '')
            ? m.title
            : (files !== undefined && files.size > 0 ? firstFileName(files) : `turn ${turn}`),
          tools: m?.tools ?? 0,
          endedAt: m?.endedAt ?? null,
          endReason: m?.endReason ?? null,
          files: files !== undefined ? [...files.values()] : [],
        }
      })
      .filter((row): row is TurnWireView => row !== null)
  }

  /** The current (open or latest) turn number for one session, or undefined. */
  currentTurnOf(sessionId: string): number | undefined {    const meta = this.turnMeta.get(sessionId)
    if (meta !== undefined && meta.size > 0) return Math.max(...meta.keys())
    const perTurn = this.turnFiles.get(sessionId)
    if (perTurn !== undefined && perTurn.size > 0) return Math.max(...perTurn.keys())
    return undefined
  }

  /** The pending approval request for one session ({id, toolName}), or null. */
  pendingApprovalOf(sessionId: string): { id: string; toolName: string; ts: number } | null {
    return this.pendingApprovals.get(sessionId) ?? null
  }

  /** Stable 7-color palette identity for one subagent (ZCode-style). */
  colorOf(id: string): string {
    let hash = 0
    for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0
    return SUBCUT_CONSISTENT_PALETTE[Math.abs(hash) % SUBCUT_CONSISTENT_PALETTE.length] ?? '#8b8b9c'
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

  /** Trim a session's turn meta map to the newest TURN_LIMIT turns. */
  private trimTurns(sessionId: string, byTurn: Map<number, TurnMeta>): void {
    if (byTurn.size <= ActivityTracker.TURN_LIMIT) return
    const oldest = byTurn.keys().next().value as number | undefined
    if (oldest !== undefined) byTurn.delete(oldest)
    this.turnMeta.set(sessionId, byTurn)
  }
}
