/**
 * Background-job output replay for the /pill JSON API ('jobs.output').
 *
 * REPLAYS the output the MODEL has read so far for one job — it never
 * consumes the model's own job_output cursor. The source is the owner
 * session's own event log (`tool/call` rows of `job_output` paired with
 * `tool/result` rows), merged with a live mirror of the `session/event`
 * append feed (the store log can lag after a host restart). Deduped by seq.
 * Pattern mirrors dsh-better-sidebar's jobs-routes.ts (BSD-3-Clause).
 */

/** One raw session event (structural subset used by the replay; the real
 *  SessionEvent carries typed data unions, so `data` stays opaque here). */
export interface PillSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** The event feed listener shape: (liveSession, event) => void. */
export type SessionEventListener = (session: unknown, event: PillSessionEvent) => void

/** The session store face the replay reads. */
export interface PillSessionStore {
  get(id: string): { events?: readonly PillSessionEvent[] } | undefined
}

/** The context face the mirror subscribes through (cordis event API). */
export interface PillEventHost {
  on(event: string, listener: SessionEventListener): () => void
  effect(fn: () => unknown, label?: string): void
}

/** The 'tool/result' message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (the inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/** Extract the plain text of a finalized tool result (text blocks joined). */
function resultText(message: ToolResultMessageLike): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as ToolResultBlockLike
    if (candidate.type !== 'tool-result') continue
    const inner = candidate.content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      if (item === null || typeof item !== 'object') continue
      const textItem = item as { type?: unknown; text?: unknown }
      if (textItem.type === 'text' && typeof textItem.text === 'string') {
        parts.push(textItem.text)
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Whether a tool/result is an error result. */
function resultIsError(message: ToolResultMessageLike): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (block === null || typeof block !== 'object') return false
    return (block as ToolResultBlockLike).type === 'tool-result'
      && (block as ToolResultBlockLike).isError === true
  })
}

/** Whether a job_output result carries no new output. */
function isNoNewOutput(text: string): boolean {
  return text.startsWith('(no new output)')
}

/** One compact job_output trace (a tool/call or its paired tool/result). */
interface JobOutputTrace {
  seq: number
  kind: 'call' | 'result'
  callId: string
  jobId?: string
  text?: string
  isError?: boolean
}

/** Extract the job_output trace of one raw session event (undefined = unrelated). */
function traceOf(event: PillSessionEvent): JobOutputTrace | undefined {
  if (event.type === 'tool/call') {
    const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
    if (data.name !== 'job_output' || typeof data.callId !== 'string') return undefined
    let jobId: string | undefined
    try {
      const args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '') as { job_id?: unknown }
      if (typeof args.job_id === 'string') jobId = args.job_id
    } catch {
      // Malformed model arguments: not a job_output pair.
    }
    if (jobId === undefined) return undefined
    return { seq: event.seq, kind: 'call', callId: data.callId, jobId }
  }
  if (event.type === 'tool/result') {
    const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
    if (message === undefined) return undefined
    const callId = message.source?.callId
    if (typeof callId !== 'string') return undefined
    return {
      seq: event.seq,
      kind: 'result',
      callId,
      text: resultText(message),
      isError: resultIsError(message),
    }
  }
  return undefined
}

/** Per-session cap of mirrored live traces (a bounded, lossy ring). */
const MIRROR_MAX_ENTRIES = 200

/**
 * The live job_output mirror: subscribes to the session append feed and
 * caches job_output traces the session store's own log can lag behind.
 */
function createJobOutputMirror(ctx: PillEventHost): { entries(sessionId: string): readonly JobOutputTrace[] } {
  const perSession = new Map<string, JobOutputTrace[]>()
  const callIds = new Map<string, Set<string>>()
  if (typeof ctx.on !== 'function') {
    return { entries: () => [] }
  }
  const dispose = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    if (event.type === 'tool/call') {
      const trace = traceOf(event)
      if (trace?.kind !== 'call') return
      let ids = callIds.get(sessionId)
      if (ids === undefined) callIds.set(sessionId, ids = new Set())
      ids.add(trace.callId)
      push(sessionId, trace)
    } else if (event.type === 'tool/result') {
      const trace = traceOf(event)
      if (trace?.kind !== 'result') return
      if (!callIds.get(sessionId)?.has(trace.callId)) return
      push(sessionId, trace)
    }
  })
  ctx.effect(() => dispose, 'dsh-agent-pill: job-output event mirror')

  const push = (sessionId: string, trace: JobOutputTrace): void => {
    let list = perSession.get(sessionId)
    if (list === undefined) perSession.set(sessionId, list = [])
    list.push(trace)
    if (list.length > MIRROR_MAX_ENTRIES) {
      const removed = list.splice(0, list.length - MIRROR_MAX_ENTRIES)
      const ids = callIds.get(sessionId)
      if (ids !== undefined) {
        for (const entry of removed) {
          if (entry.kind === 'call') ids.delete(entry.callId)
        }
        if (ids.size === 0) callIds.delete(sessionId)
      }
    }
  }

  return { entries: (sessionId) => perSession.get(sessionId) ?? [] }
}

/** The replay service the pill route calls. */
export interface JobOutputReplay {
  /** The output the model has read so far for one job (event replay, capped). */
  output(sessionId: string, id: string, outputLimit: number): { text: string; truncated: boolean; read: boolean }
}

/** Build the job-output replay bound to the session store and event feed. */
export function createJobOutputReplay(ctx: PillEventHost & { sessions: PillSessionStore }): JobOutputReplay {
  const mirror = createJobOutputMirror(ctx)
  return {
    output(sessionId, id, outputLimit) {
      const bySeq = new Map<number, JobOutputTrace>()
      for (const event of ctx.sessions.get(sessionId)?.events ?? []) {
        const trace = traceOf(event)
        if (trace !== undefined) bySeq.set(trace.seq, trace)
      }
      for (const trace of mirror.entries(sessionId)) bySeq.set(trace.seq, trace)
      const jobOf = new Map<string, string>()
      const parts: string[] = []
      let read = false
      for (const trace of [...bySeq.values()].sort((left, right) => left.seq - right.seq)) {
        if (trace.kind === 'call') {
          if (trace.jobId !== undefined) jobOf.set(trace.callId, trace.jobId)
        } else if (jobOf.get(trace.callId) === id) {
          read = true
          if (trace.isError !== true && trace.text !== undefined && !isNoNewOutput(trace.text)) {
            parts.push(trace.text)
          }
        }
      }
      const text = parts.join('\n')
      return {
        text: text.length > outputLimit ? text.slice(0, outputLimit) : text,
        truncated: text.length > outputLimit,
        read,
      }
    },
  }
}
