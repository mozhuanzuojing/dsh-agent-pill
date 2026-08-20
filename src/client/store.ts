/**
 * Module-level pill store: one state-polling loop shared by the capsule,
 * the composer dock strip and the turn-tail file rows. The capsule toggles
 * the dock; the dock opens the console popover; turn tails read per-turn
 * file data. Active sessions poll every 1.5s; idle sessions park on the
 * host long-poll and wake on activity.
 */
import { api, type PillState } from './api.ts'

type Listener = () => void

let state: PillState | null = null
let sessionId: string | undefined
let dockVisible = false
let consoleOpen = false
let started = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const fn of listeners) fn()
}

function busyOf(next: PillState): boolean {
  return next.agent.status === 'running' || next.agent.tool !== undefined
    || next.subagents.some(s => s.kind === 'child' && s.activity === 'running')
    || next.jobs.some(j => j.status === 'running' || j.status === 'stopping')
    || (next.goal !== null && next.goal.phase !== 'complete')
    || (next.agent.workflows ?? []).some(run => !run.settled)
}

/** Start the shared polling loop (idempotent). */
export function startPillStore(sessionSource: () => string | undefined): void {
  if (started) return
  started = true
  let alive = true
  let idle = false
  let inFlight = false
  let lastVersion = 0

  const loadState = async (id: string): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const next = await api.state(id)
      if (!alive) return
      state = next
      emit()
      if (!busyOf(next)) idle = true
    } catch {
      // Host may be restarting; keep the last snapshot.
    } finally {
      inFlight = false
    }
  }

  const pollOnce = async (id: string): Promise<void> => {
    try {
      const result = await api.poll(id, lastVersion)
      if (!alive) return
      lastVersion = result.version
      if (result.dirty) {
        await loadState(id)
        if (busyOf(state as PillState)) idle = false
      }
    } catch {
      // Retry the loop after a pause.
    }
  }

  const loop = async (): Promise<void> => {
    while (alive) {
      const id = sessionSource()
      if (id === undefined || id !== sessionId) {
        sessionId = id
        state = null
        idle = false
        lastVersion = 0
        emit()
        if (id === undefined) {
          await new Promise(resolve => setTimeout(resolve, 500))
          continue
        }
        await loadState(id)
      }
      if (idle) {
        await pollOnce(id)
        await new Promise(resolve => setTimeout(resolve, 400))
      } else {
        await loadState(id)
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
  }
  void loop()
}

export const pillStore = {
  getState: (): PillState | null => state,
  getSessionId: (): string | undefined => sessionId,
  getDockVisible: (): boolean => dockVisible,
  toggleDock: (): void => {
    dockVisible = !dockVisible
    emit()
  },
  setDockVisible: (visible: boolean): void => {
    if (dockVisible !== visible) {
      dockVisible = visible
      emit()
    }
  },
  getConsoleOpen: (): boolean => consoleOpen,
  setConsoleOpen: (open: boolean): void => {
    if (consoleOpen !== open) {
      consoleOpen = open
      emit()
    }
  },
  subscribe: (fn: Listener): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}
