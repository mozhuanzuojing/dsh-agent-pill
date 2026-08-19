/**
 * Typed fetch wrapper over the /pill JSON API. Every call posts to
 * `/pill/api/<method>` with the current sessionId. Failures surface as
 * {@link PillApiError} with the wire code.
 */

/** One wire failure. */
export class PillApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Wire view of the goal (mirror of the host GoalWireView). */
export interface PillGoal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
  activation?: 'armed' | 'disarmed'
}

/** Wire view of one subagent descendant row. */
export interface PillSubagent {
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

/** One `agent()` call step inside a workflow run. */
export interface PillWorkflowStep {
  seq: number
  label: string
  phase?: string
  childId?: string
  outcome?: string
}

/** One workflow run with its collected details (bounded history). */
export interface PillWorkflowRun {
  id: string
  name: string
  phase: string | null
  startedAt: number
  settled: boolean
  stopReason?: string
  steps: PillWorkflowStep[]
  files: string[]
}

/** Throttled token-meter snapshot for the current session. */
export interface PillUsage {
  totalTokens: number
  surfaceTokens: number
  surfaceDeltaTokens: number
}

/** Wire view of the live agent for the session. */
export interface PillAgent {
  status: 'idle' | 'running' | 'absent'
  /** Latest observed tool-call name (from the session event feed). */
  tool?: string
  /** Queued (inbox) message count. */
  inbox?: number
  workflows?: PillWorkflowRun[]
}

/** Accumulated adapter-reported token accounting for the session. */
export interface PillConsumed {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One global live agent (fleet overview). */
export interface PillFleetAgent {
  id: string
  status: unknown
  goal?: string
}

/** Wire view of one background job. */
export interface PillJob {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** One aggregated state snapshot. */
export interface PillState {
  sessionId: string
  ts: number
  goal: PillGoal | null
  agent: PillAgent
  subagents: PillSubagent[]
  jobs: PillJob[]
  usage?: PillUsage
  consumed?: PillConsumed
  agents?: PillFleetAgent[]
  services: { goals: boolean; subagents: boolean; jobs: boolean; agents: boolean; usage: boolean }
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/pill/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new PillApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new PillApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** The pill API surface (session scope threaded through every call). */
export const api = {
  state: (sessionId: string, signal?: AbortSignal) =>
    call<PillState>('state', { sessionId }, signal),
  goalPause: (sessionId: string, id: string, revision: number) =>
    call<unknown>('goal.pause', { sessionId, id, revision }),
  goalResume: (sessionId: string, id: string, revision: number) =>
    call<unknown>('goal.resume', { sessionId, id, revision }),
  goalComplete: (sessionId: string, id: string, revision: number) =>
    call<unknown>('goal.complete', { sessionId, id, revision }),
  goalClear: (sessionId: string, id: string, revision: number) =>
    call<unknown>('goal.clear', { sessionId, id, revision }),
  subagentInterrupt: (sessionId: string, childId: string) =>
    call<{ ok: true; outcome: string }>('subagent.interrupt', { sessionId, childId }),
  jobOutput: (sessionId: string, id: string, signal?: AbortSignal) =>
    call<{ text: string; truncated: boolean; read: boolean }>('jobs.output', { sessionId, id }, signal),
  jobKill: (sessionId: string, id: string, reason?: string) =>
    call<{ ok: true; outcome: 'requested' | 'already-finished' }>('jobs.kill', {
      sessionId,
      id,
      ...(reason !== undefined ? { reason } : {}),
    }),
}
