/**
 * dsh-agent-pill host half: the /pill JSON API.
 *
 * Aggregates per-conversation agent activity — the current goal (durable
 * `goal/change` projection replay + live append feed), the subagent
 * descendant tree, the live agent lifecycle status, and the owner's
 * background jobs — and exposes control verbs (goal pause/resume/complete/
 * clear, subagent interrupt, job kill/output replay). Every route passes
 * the same browser-trust fence as the /api gateway.
 *
 * Services that are optional in the composition (agents / goals /
 * subagents / jobs) are read through `ctx.get` and degrade per route; the
 * goal read path replays the session's own event log, so the panel works
 * even without a live agent (only the control verbs need one).
 */
import type { Context } from '@deepseek-ai/cordis'
// Declaration-merge triggers: these packages augment @deepseek-ai/cordis'
// Context and Events (ctx.goals / ctx.subagents / ctx.jobs / ctx.agents /
// agent-scoped events).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import { GoalError, decodeGoalChange, type GoalProjection, type GoalRef } from '@deepseek-ai/dsh-goal'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isTrustedApiRequest } from './trust-fence.ts'
import { PillError, readJsonBody, requireString, type PillHttpRequest, type PillHttpResponse, writeError, writeJson, writeOk } from './wire.ts'
import { createJobOutputReplay } from './jobs-output.ts'
import { ActivityTracker } from './activity.ts'

// Structural mirrors of the two runtime services that carry no type
// declaration of their own reachable from this package:
// - webRuntime: @deepseek-ai/dsh-web-app provides it at runtime under the
//   service name 'webRuntime' with only the values interface declared.
// - webServer: the @deepseek-ai/dsh-host-webserver package declares the real
//   member; the face below restates the single method this plugin touches so
//   the plugin does not need that package as a build dependency.
declare module '@deepseek-ai/cordis' {
  interface Context {
    webRuntime: {
      /** LAN literals followed by explicit invocation authorities. */
      readonly trustedHosts: readonly string[]
    }
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: PillHttpRequest, res: PillHttpResponse) => void | Promise<void>
      }): () => void
    }
  }
  interface Events {
    // The workflow engine events (@deepseek-ai/dsh-workflow) are observed
    // defensively through the ActivityTracker; the payloads are read as
    // unknown because this package does not carry the workflow package.
    'workflow/start'(info: unknown): void
    'workflow/phase'(info: unknown, title: unknown): void
    'workflow/agent-start'(info: unknown, agent: unknown): void
    'workflow/agent-end'(info: unknown, agent: unknown): void
    'workflow/end'(info: unknown, result: unknown): void
    // The fs observation feed (@deepseek-ai/dsh-fs): authoritative positive
    // or negative observations after file operations. Attributed to the
    // active workflow run at run level (the feed carries no session id).
    'fs/observed'(target: unknown, observation: unknown, actor: unknown): void
    // Agent inbox events (@deepseek-ai/dsh-agent): queued-message accounting.
    'agent/inbox/inserted'(payload: unknown): void
    'agent/inbox/claimed'(payload: unknown): void
    'agent/inbox/discarded'(payload: unknown): void
  }
}

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-agent-pill'

/** Services required before mounting. */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** Cap of one jobs.output replay in characters. */
const OUTPUT_LIMIT = 16 * 1024

/** Wire view of the goal projection (plain JSON; snapshot is already plain). */
interface GoalWireView {
  id: string
  revision: number
  objective: string
  phase: string
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
  /** Process-local continuation eligibility; present only when a live agent serves it. */
  activation?: 'armed' | 'disarmed'
}

/** Wire view of one subagent descendant row. */
interface SubagentWireView {
  kind: 'child' | 'diagnostic'
  id: string
  activity?: 'running' | 'inactive'
  hasChildren?: boolean
  mode?: 'one-shot' | 'continuable'
  label?: string
  parentId?: string
  depth?: number
  /** Process-local observation: when the child started (host clock). */
  startedAt?: number
  /** Process-local observation: when the child settled (host clock). */
  finishedAt?: number
  /** Process-local observation: the terminal stop reason. */
  stopReason?: string
  reason?: 'corrupt' | 'unsupported' | 'unavailable'
}

/**
 * Per-session goal projection: seeded by folding the session's own event
 * log at first read, then kept current by the live `session/event` append
 * feed (a `goal/change` event carries the complete post-change state, so
 * last-wins is the whole fold).
 */
class GoalTracker {
  private readonly projections = new Map<string, GoalProjection | null>()
  private readonly seeded = new Set<string>()

  constructor(private readonly sessions: Context['sessions']) {}

  /** Replay the store log once per session (idempotent, last-wins fold). */
  private seed(sessionId: string): void {
    if (this.seeded.has(sessionId)) return
    this.seeded.add(sessionId)
    let projection: GoalProjection | null = null
    for (const event of this.sessions.get(SessionId(sessionId))?.events ?? []) {
      if (event.type !== 'goal/change') continue
      projection = this.applyChange(projection, event.data)
    }
    this.projections.set(sessionId, projection)
  }

  /** Fold one decoded goal/change payload into a projection (last-wins). */
  private applyChange(previous: GoalProjection | null, raw: unknown): GoalProjection | null {
    const change = decodeGoalChange(raw)
    if (change === undefined) return previous
    if (change.operation === 'clear') return null
    return {
      goal: change.goal,
      roundsStarted: change.roundsStarted,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
    }
  }

  /** Live append-feed handler: a goal/change event refreshes the projection. */
  onSessionEvent(sessionId: string, event: { type: string; data: unknown }): void {
    if (event.type !== 'goal/change') return
    const previous = this.projections.get(sessionId) ?? null
    this.projections.set(sessionId, this.applyChange(previous, event.data))
  }

  /** Current projection for one session (seeded on demand). */
  get(sessionId: string): GoalProjection | null {
    this.seed(sessionId)
    return this.projections.get(sessionId) ?? null
  }
}

/** One API method dispatch table entry. */
type ApiMethod = (payload: unknown) => Promise<unknown> | unknown

/** Build the API method table bound to the plugin context. */
function buildApi(ctx: Context): Record<string, ApiMethod> {
  const agents = ctx.get('agents')
  const goals = ctx.get('goals')
  const subagents = ctx.get('subagents')
  const jobs = ctx.get('jobs')
  const tokenMeter = ctx.get('tokenMeter')
  const tracker = new ActivityTracker()
  const goalTracker = new GoalTracker(ctx.sessions)
  const replay = createJobOutputReplay({
    ...ctx,
    // The live agent owns the authoritative session view (its event log can
    // be ahead of / differ from the store's rehydration snapshot), so prefer
    // agent.session and fall back to the store for non-live sessions.
    sessions: {
      get: (id: string) => agents?.get(SessionId(id))?.session ?? ctx.sessions.get(SessionId(id)),
    },
  })

  /** The live agent for a session, or a 409 that names the missing service. */
  const requireAgent = (sessionId: string): Agent => {
    const agent = agents?.get(SessionId(sessionId))
    if (agent === undefined) {
      throw new PillError('goal-error', `session "${sessionId}" has no live agent`, 409)
    }
    return agent
  }

  /** The CAS ref from the payload ({id, revision}), or bad-request. */
  const requireRef = (payload: unknown): GoalRef => {
    const record = payload as Record<string, unknown> | null
    const id = record?.id
    const revision = record?.revision
    if (typeof id !== 'string' || id === '' || typeof revision !== 'number' || !Number.isInteger(revision)) {
      throw new PillError('bad-request', 'missing or invalid "id"/"revision"')
    }
    return { id: id as GoalRef['id'], revision }
  }

  /** Translate a goal service failure into the wire error envelope. */
  const goalError = (error: unknown): PillError => {
    if (error instanceof GoalError) {
      return new PillError('goal-error', error.message, 400)
    }
    return new PillError('goal-error', error instanceof Error ? error.message : String(error), 400)
  }

  /** Translate a subagent service failure into the wire error envelope. */
  const subagentError = (error: unknown): PillError => {
    if (error instanceof SubagentError) {
      return new PillError('subagent-error', error.message, 403)
    }
    return new PillError('subagent-error', error instanceof Error ? error.message : String(error), 400)
  }

  /**
   * The goal wire view. With a live agent the GoalService itself is the
   * authoritative source (it folds the agent's live session log, so it also
   * carries process-local activation); the event-log replay is the fallback
   * for sessions without a live agent (read-only durable view).
   */
  const goalViewOf = (sessionId: string): GoalWireView | null => {
    if (agents !== undefined && goals !== undefined) {
      const agent = agents.get(SessionId(sessionId))
      if (agent !== undefined) {
        try {
          const live = goals.get(agent)
          if (live !== undefined) {
            const view: GoalWireView = {
              id: live.id,
              revision: live.revision,
              objective: live.objective,
              phase: live.phase,
              maxGoalRounds: live.maxGoalRounds,
              roundsStarted: live.roundsStarted,
              createdAt: live.createdAt,
              updatedAt: live.updatedAt,
              activation: live.activation,
            }
            if (live.blockedReason !== undefined) view.blockedReason = live.blockedReason
            return view
          }
        } catch {
          // Live agent raced away: fall through to the durable replay.
        }
      }
    }
    const projection = goalTracker.get(sessionId)
    if (projection === null) return null
    const view: GoalWireView = {
      id: projection.goal.id,
      revision: projection.goal.revision,
      objective: projection.goal.objective,
      phase: projection.goal.phase,
      maxGoalRounds: projection.goal.maxGoalRounds,
      roundsStarted: projection.roundsStarted,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
    }
    if (projection.goal.blockedReason !== undefined) {
      view.blockedReason = projection.goal.blockedReason
    }
    return view
  }

  /** Subagent cache: per-session descendant tree, refreshed on demand. */
  const subagentsCache = new Map<string, { entries: SubagentWireView[]; pending: boolean }>()
  const refreshSubagents = async (sessionId: string): Promise<SubagentWireView[]> => {
    const entry = subagentsCache.get(sessionId)
    if (entry !== undefined && entry.pending) return entry.entries
    const state = entry ?? { entries: [], pending: false }
    state.pending = true
    subagentsCache.set(sessionId, state)
    try {
      if (subagents === undefined) return state.entries
      const rows = await subagents.listDescendants(SessionId(sessionId))
      state.entries = rows.map((row) => {
        if (row.kind === 'diagnostic') {
          return { kind: 'diagnostic', id: row.id, reason: row.reason, depth: row.depth, parentId: row.parentId }
        }
        const tracked = tracker.subagentOf(row.id)
        return {
          kind: 'child',
          id: row.id,
          activity: row.activity,
          hasChildren: row.hasChildren,
          mode: row.mode,
          label: row.label,
          parentId: row.parentId,
          depth: row.depth,
          ...(tracked.startedAt !== undefined ? { startedAt: tracked.startedAt } : {}),
          ...(tracked.finishedAt !== undefined ? { finishedAt: tracked.finishedAt } : {}),
          ...(tracked.stopReason !== undefined ? { stopReason: tracked.stopReason } : {}),
        }
      })
    } catch (error) {
      ctx.logger?.warn(`[dsh-agent-pill] subagent listing failed for ${sessionId}: ${String(error)}`)
    } finally {
      state.pending = false
    }
    return state.entries
  }

  /** Jobs cache: refreshed on demand and invalidated by registry changes. */
  let jobsDirty = true
  const jobsCache = new Map<string, JobSnapshot[]>()
  const listJobs = (sessionId: string): JobSnapshot[] => {
    if (jobs === undefined) return []
    if (jobsDirty) {
      jobsDirty = false
      jobsCache.clear()
    }
    if (jobsCache.has(sessionId)) return jobsCache.get(sessionId) ?? []
    const snapshots = jobs.list(agents?.get(SessionId(sessionId)))
    jobsCache.set(sessionId, snapshots)
    return snapshots
  }

  // ── Live event wiring (every subscription is effect-owned for HMR) ──────
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    goalTracker.onSessionEvent(sessionId, event)
    tracker.onSessionEvent(sessionId, event)
  }), 'dsh-agent-pill: session/event feed')
  ctx.effect(() => ctx.on('agent/inbox/inserted', (payload) => {
    const id = (payload as { agent?: { session?: { id?: unknown } } } | null)?.agent?.session?.id
    tracker.onInboxEvent(typeof id === 'string' ? id : undefined, 'inserted')
  }), 'dsh-agent-pill: inbox inserted feed')
  ctx.effect(() => ctx.on('agent/inbox/claimed', (payload) => {
    const id = (payload as { agent?: { session?: { id?: unknown } } } | null)?.agent?.session?.id
    tracker.onInboxEvent(typeof id === 'string' ? id : undefined, 'claimed')
  }), 'dsh-agent-pill: inbox claimed feed')
  ctx.effect(() => ctx.on('agent/inbox/discarded', (payload) => {
    const id = (payload as { agent?: { session?: { id?: unknown } } } | null)?.agent?.session?.id
    tracker.onInboxEvent(typeof id === 'string' ? id : undefined, 'discarded')
  }), 'dsh-agent-pill: inbox discarded feed')
  ctx.effect(() => ctx.on('subagent/start', (info) => {
    tracker.onSubagentStart(info)
    const id = (info as { id?: unknown } | null)?.id
    if (typeof id === 'string') void refreshSubagentsOf(ctx, id, refreshSubagents)
  }), 'dsh-agent-pill: subagent/start feed')
  ctx.effect(() => ctx.on('subagent/end', (info) => {
    tracker.onSubagentEnd(info)
    const id = (info as { id?: unknown } | null)?.id
    if (typeof id === 'string') void refreshSubagentsOf(ctx, id, refreshSubagents)
  }), 'dsh-agent-pill: subagent/end feed')
  ctx.effect(() => ctx.on('workflow/start', (info) => {
    tracker.onWorkflowStart(info)
  }), 'dsh-agent-pill: workflow/start feed')
  ctx.effect(() => ctx.on('workflow/phase', (info, title) => {
    tracker.onWorkflowPhase(info, title)
  }), 'dsh-agent-pill: workflow/phase feed')
  ctx.effect(() => ctx.on('workflow/agent-start', (info, agent) => {
    tracker.onWorkflowAgentStart(info, agent)
  }), 'dsh-agent-pill: workflow/agent-start feed')
  ctx.effect(() => ctx.on('workflow/agent-end', (info, agent) => {
    tracker.onWorkflowAgentEnd(info, agent)
  }), 'dsh-agent-pill: workflow/agent-end feed')
  ctx.effect(() => ctx.on('workflow/end', (info, result) => {
    tracker.onWorkflowEnd(info, result)
  }), 'dsh-agent-pill: workflow/end feed')
  ctx.effect(() => ctx.on('fs/observed', (target, observation, actor) => {
    tracker.onFsObserved(target)
  }), 'dsh-agent-pill: fs/observed feed')
  if (jobs !== undefined) {
    ctx.effect(() => jobs.onJobsChanged(() => { jobsDirty = true }), 'dsh-agent-pill: jobs change feed')
  }

  // Throttled token-meter snapshot (measurement is O(surface); 10s reuse).
  let usageAt = 0
  let usageCache: { totalTokens: number; surfaceTokens: number; surfaceDeltaTokens: number } | null = null
  const usageOf = (sessionId: string): typeof usageCache => {
    if (tokenMeter === undefined) return null
    const now = Date.now()
    if (now - usageAt < 10_000 && usageCache !== null) return usageCache
    usageAt = now
    try {
      const session = ctx.sessions.get(SessionId(sessionId))
      if (session === undefined) return null
      const measured = tokenMeter.measure(session)
      usageCache = {
        totalTokens: measured.totalTokens,
        surfaceTokens: measured.surfaceTokens,
        surfaceDeltaTokens: measured.surfaceDeltaTokens,
      }
    } catch {
      usageCache = null
    }
    return usageCache
  }

  return {
    'state': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const agent = agents?.get(SessionId(sessionId))
      const subagents = await refreshSubagents(sessionId)
      const workflows = tracker.workflowHistory()
      const usage = usageOf(sessionId)
      const consumed = tracker.usageOf(sessionId)
      const hasConsumed = consumed.input > 0 || consumed.output > 0 || consumed.cacheRead > 0 || consumed.cacheWrite > 0
      const tool = tracker.toolCallOf(sessionId)
      const inbox = tracker.inboxCountOf(sessionId)
      // Global agent fleet (tasklight / tmux-agent-sidebar style overview):
      // every live agent with its status and goal objective snippet.
      const fleet = agents !== undefined
        ? agents.list().map((entry) => ({
          id: entry.id,
          status: entry.status,
          goal: goals !== undefined ? goals.get(entry)?.objective.slice(0, 60) : undefined,
        }))
        : []
      return {
        sessionId,
        ts: Date.now(),
        goal: goalViewOf(sessionId),
        agent: {
          status: agent?.status ?? 'absent',
          ...(agent !== undefined && tool !== undefined ? { tool } : {}),
          ...(agent !== undefined && inbox > 0 ? { inbox } : {}),
          ...(workflows.length > 0 ? { workflows } : {}),
        },
        subagents,
        jobs: listJobs(sessionId).map((job) => ({
          id: job.id,
          kind: job.kind,
          label: job.label,
          status: job.status,
          detail: job.detail,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
        })),
        ...(usage !== null ? { usage } : {}),
        ...(hasConsumed ? { consumed } : {}),
        ...(fleet.length > 0 ? { agents: fleet } : {}),
        services: {
          goals: goals !== undefined,
          subagents: subagents !== undefined,
          jobs: jobs !== undefined,
          agents: agents !== undefined,
          usage: tokenMeter !== undefined,
        },
      }
    },
    'goal.pause': (payload) => {
      if (goals === undefined) throw new PillError('goal-error', 'the goal service is not mounted', 503)
      const sessionId = requireString(payload, 'sessionId')
      try {
        return goals.pause(requireAgent(sessionId), requireRef(payload))
      } catch (error) {
        throw goalError(error)
      }
    },
    'goal.resume': (payload) => {
      if (goals === undefined) throw new PillError('goal-error', 'the goal service is not mounted', 503)
      const sessionId = requireString(payload, 'sessionId')
      try {
        return goals.resume(requireAgent(sessionId), requireRef(payload))
      } catch (error) {
        throw goalError(error)
      }
    },
    'goal.complete': (payload) => {
      if (goals === undefined) throw new PillError('goal-error', 'the goal service is not mounted', 503)
      const sessionId = requireString(payload, 'sessionId')
      try {
        return goals.complete(requireAgent(sessionId), requireRef(payload))
      } catch (error) {
        throw goalError(error)
      }
    },
    'goal.clear': (payload) => {
      if (goals === undefined) throw new PillError('goal-error', 'the goal service is not mounted', 503)
      const sessionId = requireString(payload, 'sessionId')
      try {
        return goals.clear(requireAgent(sessionId), requireRef(payload))
      } catch (error) {
        throw goalError(error)
      }
    },
    'subagent.interrupt': (payload) => {
      if (subagents === undefined) throw new PillError('subagent-error', 'the subagent service is not mounted', 503)
      const sessionId = requireString(payload, 'sessionId')
      const childId = requireString(payload, 'childId')
      try {
        // Human-parent authority: the durable direct parent address the panel
        // presents. Continuable children cancel their current turn; one-shot
        // background subagents are registered as jobs and stop via jobs.kill.
        subagents.interrupt(SessionId(childId), { kind: 'user', parentSessionId: SessionId(sessionId) })
        return { ok: true, outcome: 'requested' }
      } catch (error) {
        throw subagentError(error)
      }
    },
    'jobs.output': (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      return replay.output(sessionId, id, OUTPUT_LIMIT)
    },
    'jobs.kill': (payload) => {
      if (jobs === undefined) throw new PillError('job-error', 'the background-job registry is not mounted', 503)
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      const record = payload as { reason?: unknown } | null
      const reason = typeof record?.reason === 'string' && record.reason !== ''
        ? record.reason
        : 'user requested via agent pill'
      try {
        return { ok: true, outcome: jobs.kill(JobId(id), agents?.get(SessionId(sessionId)), reason) }
      } catch (error) {
        throw new PillError('job-error', error instanceof Error ? error.message : String(error), 404)
      }
    },
  }
}

/** Resolve a subagent event's parent session and refresh its listing. */
async function refreshSubagentsOf(
  ctx: Context,
  childId: string,
  refresh: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  try {
    const header = ctx.sessions.get(SessionId(childId))?.header as { parentSession?: string } | undefined
    const parent = header?.parentSession
    if (parent !== undefined && parent !== '') await refresh(parent)
  } catch {
    // The child may already be gone; the next state poll re-lists anyway.
  }
}

/**
 * Plugin body: mount the fenced /pill/api routes and the live aggregator.
 * @param ctx - host plugin context (webServer, sessions, webRuntime).
 */
export function apply(ctx: Context): void {
  const fence = (req: PillHttpRequest): boolean =>
    isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
  const api = buildApi(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pill/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/pill/api/') ? pathname.slice('/pill/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new PillError('not-found', 'unknown pill API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new PillError('not-found', `unknown pill API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-agent-pill: /pill/api routes')
}
