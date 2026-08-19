/**
 * Pill UI: the top-right agent-activity capsule and the right summary
 * drawer. Compact styling, ZCode-inspired. The palette is driven by CSS
 * variables that follow the DSH theme automatically: the host marks the
 * active scheme on <body data-ds-dark-theme> (system/light/dark resolved
 * host-side), and the attribute selector below switches every --pill-*
 * variable, so the capsule and drawer track light/dark without any JS
 * theme detection. All data comes from the fenced /pill/api routes polled
 * every 1.5s while a session is current.
 */
import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { api, PillApiError, type PillJob, type PillState, type PillSubagent } from './api.ts'

/**
 * Theme-driven palette stylesheet. Dark is the :root default (matching the
 * pre-theme behavior); the light ("white") scheme applies while the host
 * does NOT mark the body dark — the same signal ui-theme's boot script and
 * ThemePresenter write. Injected once per mount by index.tsx (effect-owned).
 */
export const PILL_CSS = `
:root {
  --pill-bg: #16161c;
  --pill-panel: #1d1d26;
  --pill-panel2: #23232e;
  --pill-border: #2e2e3a;
  --pill-text: #e4e4ec;
  --pill-dim: #9a9aab;
  --pill-faint: #6c6c7d;
  --pill-green: #3fb96a;
  --pill-yellow: #d9a13b;
  --pill-red: #e05a5a;
  --pill-blue: #5a9cf0;
  --pill-purple: #a37de8;
  --pill-shadow: 0 2px 10px rgba(0,0,0,0.45);
  --pill-shadow-side: -6px 0 24px rgba(0,0,0,0.5);
  --pill-badge-text: #101016;
}
body:not([data-ds-dark-theme]) {
  --pill-bg: #f6f6f9;
  --pill-panel: #ffffff;
  --pill-panel2: #efeff4;
  --pill-border: #e2e2ea;
  --pill-text: #1d1d27;
  --pill-dim: #56566a;
  --pill-faint: #8b8b9c;
  --pill-green: #1f9d55;
  --pill-yellow: #a97d1f;
  --pill-red: #d64545;
  --pill-blue: #2d6fd8;
  --pill-purple: #7a4fd0;
  --pill-shadow: 0 2px 10px rgba(0,0,0,0.14);
  --pill-shadow-side: -6px 0 24px rgba(0,0,0,0.16);
  --pill-badge-text: #ffffff;
}
`

/* ── Palette (CSS variables; switches with the DSH theme automatically) ─── */
const C = {
  bg: 'var(--pill-bg)',
  panel: 'var(--pill-panel)',
  panel2: 'var(--pill-panel2)',
  border: 'var(--pill-border)',
  text: 'var(--pill-text)',
  dim: 'var(--pill-dim)',
  faint: 'var(--pill-faint)',
  green: 'var(--pill-green)',
  yellow: 'var(--pill-yellow)',
  red: 'var(--pill-red)',
  blue: 'var(--pill-blue)',
  purple: 'var(--pill-purple)',
}

/** Shared label rows: value + optional hint. */
function Row(props: { label: string; value: string; color?: string }): JSX.Element {
  return createElement('div', { style: rowStyle },
    createElement('span', { style: { color: C.faint, fontSize: 11, minWidth: 64 } }, props.label),
    createElement('span', {
      style: { color: props.color ?? C.text, fontSize: 12, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' },
    }, props.value),
  )
}

/** Section header. */
function Section(props: { title: string; count?: number; right?: JSX.Element }): JSX.Element {
  return createElement('div', { style: sectionStyle },
    createElement('span', { style: { color: C.faint, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' as const } },
      props.title + (props.count !== undefined ? ` (${props.count})` : '')),
    props.right ?? null,
  )
}

/** Small icon button. */
function IconButton(props: { label: string; onClick: () => void; color?: string; disabled?: boolean }): JSX.Element {
  return createElement('button', {
    onClick: props.onClick,
    disabled: props.disabled,
    'aria-label': props.label,
    title: props.label,
    style: {
      ...iconButtonStyle,
      ...(props.color !== undefined ? { borderColor: props.color, color: props.color } : {}),
      ...(props.disabled === true ? { opacity: 0.4, cursor: 'default' } : {}),
    },
  }, props.label)
}

const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }
const sectionStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginTop: 14, marginBottom: 6, borderBottom: `1px solid ${C.border}`, paddingBottom: 4,
}
const iconButtonStyle: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5,
  color: C.text, fontSize: 11, padding: '3px 8px', cursor: 'pointer', lineHeight: 1.2,
}
const iconButtonStyleSmall: React.CSSProperties = {
  ...iconButtonStyle,
  padding: '1px 6px', fontSize: 10, color: C.dim,
}

/** Phase → color + Chinese/English label mapping. */
const PHASE_META: Record<string, { color: string; label: string }> = {
  active: { color: C.yellow, label: 'active' },
  paused: { color: C.dim, label: 'paused' },
  blocked: { color: C.red, label: 'blocked' },
  complete: { color: C.green, label: 'complete' },
}

function fmtAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

/** Compact token count: 12345 → "12.3k", -500 → "-500". */
function fmtTokens(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Durable duration (ZCode goal cards show elapsed time next to the objective). */
function fmtDur(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** localStorage key holding the dragged capsule position ({x, y} px). */
const POS_KEY = 'dsh-agent-pill.position'

/** Read the persisted capsule position; malformed/absent values fall back to the default top-right seat. */
function loadCapsulePos(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

/* ── Drawer sections ────────────────────────────────────────────────────── */

function GoalCard(props: { state: PillState; onAction: () => void }): JSX.Element {
  const { state, onAction } = props
  const goal = state.goal
  if (goal === null) {
    return createElement('div', { style: { color: C.faint, fontSize: 12, padding: '4px 0' } }, 'No goal set')
  }
  const meta = PHASE_META[goal.phase] ?? { color: C.yellow, label: 'active' }
  const disabled = goal.phase === 'complete'
  const act = (fn: () => Promise<unknown>): void => {
    void fn().catch((error: unknown) => {
      console.error('[dsh-agent-pill] goal action failed:', error)
    }).then(onAction)
  }
  return createElement('div', {
    style: { background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' },
  },
    createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
      createElement('span', {
        style: { width: 8, height: 8, borderRadius: 4, background: meta.color, flexShrink: 0 },
      }),
      createElement('span', {
        style: {
          fontSize: 12, color: C.text, fontWeight: 600, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        },
        title: goal.objective,
      }, goal.objective),
    ),
    createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 } },
      createElement('span', { style: { color: meta.color, fontSize: 10, border: `1px solid ${meta.color}`, borderRadius: 4, padding: '0 5px', lineHeight: '15px' } }, meta.label),
      createElement('span', { style: { color: C.faint, fontSize: 11 } },
        `round ${goal.roundsStarted}/${goal.maxGoalRounds} · elapsed ${fmtDur(goal.createdAt, state.ts)}`),
      goal.activation !== undefined
        ? createElement('span', { style: { color: C.faint, fontSize: 10 } }, `activation: ${goal.activation}`)
        : null,
    ),
    goal.maxGoalRounds > 0
      ? createElement('div', {
        style: { height: 5, borderRadius: 3, background: C.bg, overflow: 'hidden', marginBottom: 6 },
        title: `${goal.roundsStarted}/${goal.maxGoalRounds} rounds`,
      },
        createElement('div', {
          style: {
            height: '100%',
            width: `${Math.min(100, Math.round((goal.roundsStarted / goal.maxGoalRounds) * 100))}%`,
            background: meta.color, borderRadius: 3,
          },
        }),
      )
      : null,
    goal.blockedReason !== undefined
      ? createElement('div', { style: { color: C.red, fontSize: 11, marginBottom: 6 } }, goal.blockedReason.message)
      : null,
    createElement('div', { style: { display: 'flex', gap: 6 } },
      goal.phase === 'active'
        ? createElement(IconButton, { label: 'Pause', onClick: () => act(() => api.goalPause(state.sessionId, goal.id, goal.revision)), color: C.yellow })
        : null,
      goal.phase === 'paused' || goal.phase === 'blocked'
        ? createElement(IconButton, { label: 'Resume', onClick: () => act(() => api.goalResume(state.sessionId, goal.id, goal.revision)), color: C.green })
        : null,
      goal.phase !== 'complete'
        ? createElement(IconButton, { label: 'Complete', onClick: () => act(() => api.goalComplete(state.sessionId, goal.id, goal.revision)), color: C.green })
        : null,
      createElement(IconButton, {
        label: 'Clear', onClick: () => act(() => api.goalClear(state.sessionId, goal.id, goal.revision)),
        color: C.red, disabled,
      }),
    ),
  )
}

function SubagentList(props: { state: PillState; onAction: () => void }): JSX.Element {
  const { state, onAction } = props
  const children = state.subagents.filter((s): s is PillSubagent & { kind: 'child' } => s.kind === 'child')
  const diagnostics = state.subagents.filter(s => s.kind === 'diagnostic')
  if (children.length === 0 && diagnostics.length === 0) {
    return createElement('div', { style: { color: C.faint, fontSize: 12, padding: '4px 0' } }, 'No subagents')
  }
  const stop = (childId: string): void => {
    void api.subagentInterrupt(state.sessionId, childId)
      .catch((error: unknown) => console.error('[dsh-agent-pill] interrupt failed:', error))
      .then(onAction)
  }
  return createElement('div', null, [
    ...children.map((child) => {
      const now = state.ts
      const indent = 8 + (child.depth ?? 0) * 14
      const elapsed = child.startedAt !== undefined
        ? child.finishedAt !== undefined
          ? ` · ran ${fmtDur(child.startedAt, child.finishedAt)}`
          : ` · ${fmtDur(child.startedAt, now)}`
        : ''
      const settled = child.stopReason !== undefined ? ` · ${child.stopReason}` : ''
      const metaColor = child.stopReason === 'failed' ? C.red : C.faint
      return createElement('div', {
        key: child.id,
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', paddingLeft: indent },
      },
        createElement('span', {
          style: {
            width: 7, height: 7, borderRadius: 4, flexShrink: 0,
            background: child.activity === 'running' ? C.yellow : C.faint,
          },
        }),
        createElement('div', { style: { flex: 1, minWidth: 0 } },
          createElement('div', {
            style: { fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: child.id,
          }, child.label ?? child.id),
          createElement('div', { style: { color: metaColor, fontSize: 10 } },
            `${child.mode ?? 'one-shot'} · ${child.activity ?? 'inactive'}${elapsed}${settled}`),
        ),
        createElement('button', {
          onClick: () => stop(child.id),
          title: `Interrupt ${child.id}`,
          'aria-label': `Interrupt ${child.id}`,
          style: iconButtonStyleSmall,
        }, 'stop'),
      )
    }),
    ...diagnostics.map((d) => createElement('div', {
      key: d.id, style: { color: C.red, fontSize: 11, padding: '2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      title: d.id,
    }, `unreadable: ${d.reason} (${d.id})`)),
  ])
}

function JobRow(props: { job: PillJob; sessionId: string; now: number; onAction: () => void }): JSX.Element {
  const { job, sessionId, now, onAction } = props
  const [output, setOutput] = useState<{ text: string; truncated: boolean; read: boolean } | 'loading' | null>(null)
  const [busy, setBusy] = useState(false)
  const statusColor = job.status === 'running' || job.status === 'stopping' ? C.yellow
    : job.status === 'completed' ? C.green
    : job.status === 'killed' ? C.dim
    : C.red
  const timing = job.finishedAt !== undefined
    ? ` · took ${fmtDur(job.startedAt, job.finishedAt)} (${fmtAgo(job.finishedAt, now)} ago)`
    : ` · started ${fmtAgo(job.startedAt, now)} ago`
  const toggle = (): void => {
    if (output !== null && output !== 'loading') {
      setOutput(null)
      return
    }
    setOutput('loading')
    void api.jobOutput(sessionId, job.id).then(setOutput).catch((error: unknown) => {
      console.error('[dsh-agent-pill] job output failed:', error)
      setOutput(null)
    })
  }
  const kill = (): void => {
    if (busy) return
    setBusy(true)
    void api.jobKill(sessionId, job.id, 'user requested via agent pill')
      .catch((error: unknown) => console.error('[dsh-agent-pill] job kill failed:', error))
      .then(() => { setBusy(false) })
      .then(onAction)
  }
  return createElement('div', { style: { padding: '4px 0' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', { style: { width: 7, height: 7, borderRadius: 4, background: statusColor, flexShrink: 0 } }),
      createElement('div', { style: { flex: 1, minWidth: 0 } },
        createElement('div', {
          style: { fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: `${job.id} · ${job.label}`,
        }, job.label),
        createElement('div', { style: { color: C.faint, fontSize: 10 } },
          `${job.id} · ${job.status}${job.detail !== undefined ? ` · ${job.detail}` : ''}${timing}`),
      ),
      createElement('button', {
        onClick: toggle, title: 'Output', 'aria-label': 'Output', style: iconButtonStyleSmall,
      }, output !== null && output !== 'loading' ? 'hide' : 'out'),
      (job.status === 'running' || job.status === 'stopping')
        ? createElement('button', {
          onClick: kill, title: 'Kill', 'aria-label': 'Kill', style: iconButtonStyleSmall, disabled: busy,
        }, 'kill')
        : null,
    ),
    output === 'loading'
      ? createElement('div', { style: { color: C.faint, fontSize: 11, padding: '4px 0 0 15px' } }, 'loading…')
      : output !== null
        ? createElement('pre', {
          style: {
            margin: '4px 0 0 15px', padding: 6, background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 5, fontSize: 11, lineHeight: 1.45, color: C.text,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 160, overflow: 'auto',
          },
        }, output.text === '' ? (output.read ? '(no readable output yet)' : '(model has not read this job)') : output.text + (output.truncated ? '\n…(truncated)' : ''))
        : null,
  )
}

function JobList(props: { state: PillState; onAction: () => void }): JSX.Element {
  const { state, onAction } = props
  if (state.jobs.length === 0) {
    return createElement('div', { style: { color: C.faint, fontSize: 12, padding: '4px 0' } }, 'No background jobs')
  }
  return createElement('div', null,
    state.jobs.map((job) => createElement(JobRow, {
      key: job.id, job, sessionId: state.sessionId, now: state.ts, onAction,
    })),
  )
}

/* ── Root: capsule + drawer ─────────────────────────────────────────────── */

function PillRoot(props: { sessions: ISessions }): JSX.Element {
  const { sessions } = props
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PillState | null>(null)
  const inFlight = useRef(false)

  // ── Capsule drag ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadCapsulePos)
  const [dragging, setDragging] = useState(false)
  const posRef = useRef(pos)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)
  // One-shot suppression of the click that follows a drag end (a drag must
  // not toggle the drawer); consumed by onClick, never left dangling.
  const suppressClickRef = useRef(false)

  // Subscribe to the session list feed (current session id).
  const snapshot = useSyncExternalStore(
    useMemo(() => (cb: () => void) => sessions.list.subscribe(cb), [sessions]),
    useMemo(() => () => sessions.list.getSnapshot(), [sessions]),
  )
  const sessionId = snapshot.current

  // Poll the aggregated state while a session is current.
  useEffect(() => {
    if (sessionId === undefined) {
      setState(null)
      return
    }
    const controller = new AbortController()
    let alive = true
    const tick = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const next = await api.state(sessionId, controller.signal)
        if (alive) setState(next)
      } catch (error) {
        if (error instanceof PillApiError && error.code === 'network') {
          // Host may be restarting; keep the last snapshot.
        } else if (alive) {
          setState(null)
        }
      } finally {
        inFlight.current = false
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1500)
    return () => {
      alive = false
      controller.abort()
      window.clearInterval(timer)
    }
  }, [sessionId])

  // Ctrl+Alt+P toggles the drawer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault()
        setOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Close the drawer when switching sessions.
  useEffect(() => {
    setOpen(false)
  }, [sessionId])

  // Keep a dragged seat inside the viewport after window resizes.
  useEffect(() => {
    const onResize = (): void => {
      const current = posRef.current
      if (current === null) return
      const host = document.querySelector<HTMLElement>('[data-dsh-agent-pill] button')
      if (host === null) return
      const clamped = {
        x: Math.min(current.x, Math.max(0, window.innerWidth - host.offsetWidth)),
        y: Math.min(current.y, Math.max(0, window.innerHeight - host.offsetHeight)),
      }
      if (clamped.x !== current.x || clamped.y !== current.y) {
        posRef.current = clamped
        setPos(clamped)
        try { window.localStorage.setItem(POS_KEY, JSON.stringify(clamped)) } catch { /* private mode */ }
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Activity summary driving the capsule.
  const goal = state?.goal ?? null
  const goalActive = goal !== null && (goal.phase === 'active' || goal.phase === 'paused' || goal.phase === 'blocked')
  const workflow = state?.agent.workflow
  const workflowRunning = workflow !== undefined && !workflow.settled
  const runningSubagents = state?.subagents.filter(s => s.kind === 'child' && s.activity === 'running').length ?? 0
  const runningJobs = state?.jobs.filter(j => j.status === 'running' || j.status === 'stopping').length ?? 0
  const failedJobs = state?.jobs.filter(j => j.status === 'failed').length ?? 0
  const agentRunning = state?.agent.status === 'running'
  const busy = agentRunning || runningSubagents > 0 || runningJobs > 0 || goal?.phase === 'active' || workflowRunning
  const dotColor = state === null ? C.faint
    : goal?.phase === 'blocked' ? C.red
    : busy ? C.yellow
    : C.green

  const counts: Array<{ value: string; color: string; title: string }> = []
  if (runningSubagents > 0) counts.push({ value: String(runningSubagents), color: C.purple, title: 'running subagents' })
  if (runningJobs > 0) counts.push({ value: String(runningJobs), color: C.blue, title: 'running jobs' })
  if (workflowRunning) counts.push({
    value: 'wf', color: C.purple,
    title: `workflow: ${workflow.name}${workflow.phase !== null ? ` · ${workflow.phase}` : ''}`,
  })
  if (failedJobs > 0) counts.push({ value: String(failedJobs), color: C.red, title: 'failed jobs' })
  if (goal !== null && goal.phase !== 'complete') {
    counts.push({ value: 'G', color: PHASE_META[goal.phase]?.color ?? C.yellow, title: `goal: ${goal.phase}` })
  }

  return createElement('div', null,
    // ── Capsule (draggable; click toggles the drawer) ──
    createElement('button', {
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        // The click immediately following a drag end must not toggle.
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          event.preventDefault()
          return
        }
        setOpen(prev => !prev)
      },
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        const el = event.currentTarget
        const rect = el.getBoundingClientRect()
        dragRef.current = {
          startX: event.clientX, startY: event.clientY,
          origX: rect.left, origY: rect.top, moved: false,
        }
        try { el.setPointerCapture(event.pointerId) } catch { /* capture unsupported */ }
      },
      onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current
        if (drag === null) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved && Math.hypot(dx, dy) < 4) return // click slop
        drag.moved = true
        if (!dragging) setDragging(true)
        const el = event.currentTarget
        const next = {
          x: Math.min(Math.max(0, drag.origX + dx), Math.max(0, window.innerWidth - el.offsetWidth)),
          y: Math.min(Math.max(0, drag.origY + dy), Math.max(0, window.innerHeight - el.offsetHeight)),
        }
        posRef.current = next
        setPos(next)
      },
      onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current
        if (drag === null) return
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
        if (drag.moved) {
          // Persist the dragged seat so a reload keeps it, and suppress the
          // click that follows the drag end.
          try { window.localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)) } catch { /* private mode */ }
          suppressClickRef.current = true
        }
        dragRef.current = null
        setDragging(false)
      },
      title: `Agent activity (${counts.map(c => c.title).join(', ') || 'idle'}) — drag to move, click or Ctrl+Alt+P for panel`,
      'aria-label': 'Agent activity',
      'aria-pressed': open,
      style: {
        position: 'fixed', zIndex: 2147483001,
        ...(pos === null ? { top: 14, right: 14 } : { top: pos.y, left: pos.x }),
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: 999,
        padding: '6px 12px', cursor: dragging ? 'grabbing' : 'grab',
        boxShadow: 'var(--pill-shadow)',
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
      },
    },
      createElement('span', {
        style: {
          width: 9, height: 9, borderRadius: 5, background: dotColor, flexShrink: 0,
          boxShadow: `0 0 6px ${dotColor}`,
        },
      }),
      createElement('span', { style: { color: C.text, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em' } }, 'AGENT'),
      goal !== null && goal.phase !== 'complete'
        ? createElement('span', {
          style: { color: C.faint, fontSize: 10, fontVariantNumeric: 'tabular-nums' },
          title: `goal running for ${fmtDur(goal.createdAt, state?.ts ?? Date.now())}`,
        }, `⏱ ${fmtDur(goal.createdAt, state?.ts ?? Date.now())}`)
        : null,
      counts.map((count, index) => createElement('span', {
        key: index,
        style: {
          minWidth: 16, height: 16, borderRadius: 8, background: count.color, color: 'var(--pill-badge-text)',
          fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', padding: '0 5px',
        },
        title: count.title,
      }, count.value)),
    ),
    // ── Drawer ──
    open
      ? createElement('div', {
        style: {
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 348, zIndex: 2147483002,
          background: C.bg, borderLeft: `1px solid ${C.border}`,
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--pill-shadow-side)',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        },
      },
        createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0,
          },
        },
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            createElement('span', { style: { width: 9, height: 9, borderRadius: 5, background: dotColor } }),
            createElement('span', { style: { color: C.text, fontSize: 13, fontWeight: 700 } }, 'Agent Activity'),
            state !== null
              ? createElement('span', { style: { color: C.faint, fontSize: 10 } }, state.sessionId)
              : null,
          ),
          createElement('button', {
            onClick: () => setOpen(false), 'aria-label': 'Close', title: 'Close (Ctrl+Alt+P)',
            style: { ...iconButtonStyle, fontSize: 13, padding: '2px 9px' },
          }, '✕'),
        ),
        // ── Scrollable body ──
        createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '4px 14px 20px' } },
          state === null
            ? createElement('div', { style: { color: C.faint, fontSize: 12, padding: '16px 0' } },
              sessionId === undefined ? 'No active conversation' : 'Loading…')
            : createElement('div', null,
              createElement(Section, { title: 'Goal' }),
              createElement(GoalCard, { state, onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) } }),
              createElement(Section, { title: 'Agent' }),
              createElement(Row, {
                label: 'status',
                value: state.agent.status,
                color: state.agent.status === 'running' ? C.yellow : state.agent.status === 'idle' ? C.green : C.faint,
              }),
              state.agent.workflow !== undefined
                ? createElement(Row, {
                  label: 'workflow',
                  value: `${state.agent.workflow.name}${state.agent.workflow.phase !== null ? ` · ${state.agent.workflow.phase}` : ''}${state.agent.workflow.settled ? ` · ${state.agent.workflow.stopReason ?? 'ended'}` : ` · ${fmtDur(state.agent.workflow.startedAt, state.ts)}`}`,
                  color: state.agent.workflow.settled ? C.faint : C.purple,
                })
                : null,
              createElement(Section, {
                title: 'Subagents',
                count: state.subagents.filter(s => s.kind === 'child').length,
              }),
              createElement(SubagentList, { state, onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) } }),
              createElement(Section, { title: 'Jobs', count: state.jobs.length }),
              createElement(JobList, { state, onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) } }),
              state.services.usage
                ? createElement('div', null,
                  createElement(Section, { title: 'Usage' }),
                  state.usage !== undefined
                    ? createElement('div', null,
                      createElement(Row, { label: 'pressure', value: fmtTokens(state.usage.totalTokens), color: C.text }),
                      createElement(Row, { label: 'surface', value: fmtTokens(state.usage.surfaceTokens), color: C.text }),
                      createElement(Row, {
                        label: 'delta',
                        value: fmtTokens(state.usage.surfaceDeltaTokens),
                        color: state.usage.surfaceDeltaTokens >= 0 ? C.text : C.green,
                      }),
                    )
                    : createElement('div', { style: { color: C.faint, fontSize: 12, padding: '4px 0' } }, 'unavailable'),
                )
                : null,
              !state.services.goals || !state.services.subagents || !state.services.jobs
                ? createElement('div', {
                  style: { marginTop: 14, color: C.faint, fontSize: 10, lineHeight: 1.5 },
                }, `Optional services: goals=${state.services.goals ? 'on' : 'off'} · subagents=${state.services.subagents ? 'on' : 'off'} · jobs=${state.services.jobs ? 'on' : 'off'}`)
                : null,
            ),
        ),
      )
      : null,
  )
}

export { PillRoot }
