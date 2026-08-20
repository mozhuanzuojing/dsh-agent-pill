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
import { api, PillApiError, type PillJob, type PillState, type PillSubagent, type PillWorkflowRun } from './api.ts'

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
@keyframes pill-layer-in { from { transform: translateX(14px); opacity: 0.5; } to { transform: none; opacity: 1; } }
@keyframes pill-layer-back { from { transform: translateX(-14px); opacity: 0.5; } to { transform: none; opacity: 1; } }
.pill-layer-in { animation: pill-layer-in 100ms ease-out; }
.pill-layer-back { animation: pill-layer-back 100ms ease-out; }
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

/** Section header, optionally collapsible (click toggles). */
function Section(props: {
  title: string
  count?: number
  right?: JSX.Element
  onToggle?: () => void
  collapsed?: boolean
}): JSX.Element {
  const collapsible = props.onToggle !== undefined
  return createElement('div', {
    style: { ...sectionStyle, ...(collapsible ? { cursor: 'pointer' } : {}) },
    ...(collapsible
      ? { onClick: props.onToggle, title: props.collapsed === true ? 'Expand section' : 'Collapse section' }
      : {}),
  },
    createElement('span', {
      style: { color: C.faint, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' as const },
    }, `${collapsible ? (props.collapsed === true ? '▸ ' : '▾ ') : ''}${props.title}${props.count !== undefined ? ` (${props.count})` : ''}`),
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

/* ── DeepSeek cost estimate (official list prices, USD per 1M tokens) ──── */
// Source: https://api-docs.deepseek.com/quick_start/pricing — peak hours
// (Beijing 09:00-12:00, 14:00-18:00) double the price, off-peak halves it.
const PRICE_INPUT = 0.27
const PRICE_CACHE_READ = 0.07
const PRICE_CACHE_WRITE = 0.27
const PRICE_OUTPUT = 1.10
/** Estimated context window used for the pressure bar when unknown. */
const EST_CONTEXT_WINDOW = 200_000

/** Current Beijing-time hour (for peak/off-peak pricing). */
function bjHour(): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false })
      .formatToParts(new Date())
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
  } catch {
    return 0
  }
}

/** Peak (2x) / off-peak (0.5x) multiplier by Beijing time. */
function priceMultiplier(): number {
  const h = bjHour()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18) ? 2 : 0.5
}

/** Estimated session cost in USD from accumulated token accounting. */
function estimateCostUsd(consumed: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const mult = priceMultiplier()
  return (
    consumed.input * PRICE_INPUT +
    consumed.cacheRead * PRICE_CACHE_READ +
    consumed.cacheWrite * PRICE_CACHE_WRITE +
    consumed.output * PRICE_OUTPUT
  ) * mult / 1_000_000
}

/** Browser notification (permission requested lazily; never throws). */
function notify(title: string, body: string): void {
  try {
    if (!('Notification' in window)) return
    if (Notification.permission === 'granted') {
      new Notification(title, { body })
    } else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((permission) => {
        if (permission === 'granted') new Notification(title, { body })
      })
    }
  } catch { /* notifications unsupported */ }
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

function SubagentList(props: {
  state: PillState
  onAction: () => void
  onOpen: (child: PillSubagent & { kind: 'child' }) => void
}): JSX.Element {
  const { state, onAction, onOpen } = props
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
        onClick: () => onOpen(child),
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', paddingLeft: indent, cursor: 'pointer' },
        title: child.id,
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
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation()
            stop(child.id)
          },
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

/** Subagent detail layer (pushed on top of the main view, back returns). */
function SubagentDetail(props: { child: PillSubagent; ts: number; sessionId: string; onAction: () => void }): JSX.Element {
  const { child, ts, sessionId, onAction } = props
  const metaColor = child.stopReason === 'failed' ? C.red : C.faint
  const elapsed = child.startedAt !== undefined
    ? child.finishedAt !== undefined
      ? fmtDur(child.startedAt, child.finishedAt)
      : fmtDur(child.startedAt, ts)
    : 'unknown'
  const stop = (): void => {
    void api.subagentInterrupt(sessionId, child.id)
      .catch((error: unknown) => console.error('[dsh-agent-pill] interrupt failed:', error))
      .then(onAction)
  }
  return createElement('div', null,
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', marginBottom: 6 } },
      createElement('span', {
        style: {
          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
          background: child.activity === 'running' ? C.yellow : C.faint,
        },
      }),
      createElement('span', {
        style: { fontSize: 13, color: C.text, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, child.label ?? child.id),
    ),
    createElement(Row, { label: 'id', value: child.id, color: C.faint }),
    createElement(Row, { label: 'mode', value: child.mode ?? 'one-shot', color: C.text }),
    createElement(Row, { label: 'activity', value: child.activity ?? 'inactive', color: child.activity === 'running' ? C.yellow : metaColor }),
    child.depth !== undefined
      ? createElement(Row, { label: 'depth', value: String(child.depth), color: C.text })
      : null,
    child.parentId !== undefined
      ? createElement(Row, { label: 'parent', value: child.parentId, color: C.faint })
      : null,
    createElement(Row, { label: 'elapsed', value: elapsed, color: C.text }),
    child.stopReason !== undefined
      ? createElement(Row, { label: 'ended', value: child.stopReason, color: metaColor })
      : null,
    child.activity === 'running'
      ? createElement('div', { style: { marginTop: 10 } },
        createElement(IconButton, { label: 'Stop (interrupt)', onClick: stop, color: C.red }),
      )
      : null,
  )
}

/** One job row in the list; click pushes the job detail layer. */
function JobRow(props: { job: PillJob; now: number; onOpen: (job: PillJob) => void }): JSX.Element {
  const { job, now, onOpen } = props
  const statusColor = job.status === 'running' || job.status === 'stopping' ? C.yellow
    : job.status === 'completed' ? C.green
    : job.status === 'killed' ? C.dim
    : C.red
  const timing = job.finishedAt !== undefined
    ? ` · took ${fmtDur(job.startedAt, job.finishedAt)} (${fmtAgo(job.finishedAt, now)} ago)`
    : ` · started ${fmtAgo(job.startedAt, now)} ago`
  return createElement('div', {
    onClick: () => onOpen(job),
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' },
    title: job.id,
  },
    createElement('span', { style: { width: 7, height: 7, borderRadius: 4, background: statusColor, flexShrink: 0 } }),
    createElement('div', { style: { flex: 1, minWidth: 0 } },
      createElement('div', {
        style: { fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: `${job.id} · ${job.label}`,
      }, job.label),
      createElement('div', { style: { color: C.faint, fontSize: 10 } },
        `${job.id} · ${job.status}${job.detail !== undefined ? ` · ${job.detail}` : ''}${timing}`),
    ),
    createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, '›'),
  )
}

/** Job detail layer: identity, timing, full output and kill control. */
function JobDetail(props: { job: PillJob; sessionId: string; ts: number; onAction: () => void }): JSX.Element {
  const { job, sessionId, ts, onAction } = props
  const [output, setOutput] = useState<{ text: string; truncated: boolean; read: boolean } | 'loading' | null>(null)
  const [busy, setBusy] = useState(false)
  const statusColor = job.status === 'running' || job.status === 'stopping' ? C.yellow
    : job.status === 'completed' ? C.green
    : job.status === 'killed' ? C.dim
    : C.red
  // Load the output lazily on first mount of the detail layer.
  useEffect(() => {
    let alive = true
    setOutput('loading')
    void api.jobOutput(sessionId, job.id).then((next) => {
      if (alive) setOutput(next)
    }).catch(() => {
      if (alive) setOutput(null)
    })
    return () => { alive = false }
  }, [sessionId, job.id])
  const kill = (): void => {
    if (busy) return
    setBusy(true)
    void api.jobKill(sessionId, job.id, 'user requested via agent pill')
      .catch((error: unknown) => console.error('[dsh-agent-pill] job kill failed:', error))
      .then(() => { setBusy(false) })
      .then(onAction)
  }
  return createElement('div', null,
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', marginBottom: 6 } },
      createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: statusColor, flexShrink: 0 } }),
      createElement('span', {
        style: { fontSize: 13, color: C.text, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, job.label),
    ),
    createElement(Row, { label: 'id', value: job.id, color: C.faint }),
    createElement(Row, { label: 'kind', value: job.kind, color: C.text }),
    createElement(Row, { label: 'status', value: job.status, color: statusColor }),
    job.detail !== undefined
      ? createElement(Row, { label: 'detail', value: job.detail, color: C.text })
      : null,
    createElement(Row, { label: 'elapsed', value: fmtDur(job.startedAt, job.finishedAt ?? ts), color: C.text }),
    job.finishedAt !== undefined
      ? createElement(Row, { label: 'ended', value: fmtAgo(job.finishedAt, ts) + ' ago', color: C.faint })
      : null,
    (job.status === 'running' || job.status === 'stopping')
      ? createElement('div', { style: { marginTop: 10 } },
        createElement(IconButton, { label: 'Kill', onClick: kill, color: C.red, disabled: busy }),
      )
      : null,
    createElement('div', { style: { color: C.faint, fontSize: 10, marginTop: 12, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } }, 'Output'),
    output === 'loading'
      ? createElement('div', { style: { color: C.faint, fontSize: 11, padding: '2px 0' } }, 'loading…')
      : output !== null
        ? createElement('pre', {
          style: {
            margin: '4px 0 0', padding: 8, background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 5, fontSize: 11, lineHeight: 1.45, color: C.text,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 320, overflow: 'auto',
          },
        }, output.text === '' ? (output.read ? '(no readable output yet)' : '(model has not read this job)') : output.text + (output.truncated ? '\n…(truncated)' : ''))
        : createElement('div', { style: { color: C.faint, fontSize: 11, padding: '2px 0' } }, 'unavailable'),
  )
}

function JobList(props: { state: PillState; onOpen: (job: PillJob) => void }): JSX.Element | null {
  const { state, onOpen } = props
  if (state.jobs.length === 0) return null
  return createElement('div', null,
    state.jobs.map((job) => createElement(JobRow, {
      key: job.id, job, now: state.ts, onOpen,
    })),
  )
}

/* ── Workflow history: runs with steps and observed files ──────────────── */

/** One workflow run row in the list; click pushes the detail layer. */
function WorkflowRow(props: {
  run: PillWorkflowRun
  ts: number
  onOpen: (run: PillWorkflowRun) => void
}): JSX.Element {
  const { run, ts, onOpen } = props
  const statusColor = run.settled
    ? run.stopReason === 'completed' ? C.green
      : run.stopReason === 'error' ? C.red
      : C.dim
    : C.yellow
  return createElement('div', {
    onClick: () => onOpen(run),
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', cursor: 'pointer', borderRadius: 6, background: C.panel2, border: `1px solid ${C.border}`, marginBottom: 4 },
    title: run.id,
  },
    createElement('span', { style: { width: 7, height: 7, borderRadius: 4, background: statusColor, flexShrink: 0 } }),
    createElement('span', {
      style: { fontSize: 12, color: C.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
    }, run.name),
    createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } },
      `${run.settled ? (run.stopReason ?? 'ended') : (run.phase ?? 'starting')} · ${fmtDur(run.startedAt, ts)}`),
    createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, '›'),
  )
}

/** Workflow detail layer (pushed on top of the main view, back returns). */
function WorkflowDetail(props: {
  run: PillWorkflowRun
  ts: number
  subagents: PillSubagent[]
  onOpenSubagent: (childId: string) => void
}): JSX.Element {
  const { run, ts, subagents, onOpenSubagent } = props
  const [copied, setCopied] = useState<string | null>(null)
  const statusColor = run.settled
    ? run.stopReason === 'completed' ? C.green
      : run.stopReason === 'error' ? C.red
      : C.dim
    : C.yellow
  const outcomeColor = (outcome: string | undefined): string =>
    outcome === 'completed' ? C.green : outcome === 'failed' ? C.red : outcome === 'cancelled' ? C.dim : C.faint
  const fileBase = (path: string): string => path.split(/[\\/]/).pop() ?? path
  // Step ↔ subagent linkage: the step's child session resolves against the
  // observed subagent rows for duration and terminal color (v0.6.0).
  const stepMeta = (childId: string | undefined): { detail: string; color: string } => {
    if (childId === undefined) return { detail: '', color: C.faint }
    const child = subagents.find(s => s.id === childId)
    if (child === undefined) return { detail: '', color: C.faint }
    if (child.startedAt !== undefined && child.finishedAt !== undefined) {
      return { detail: ` · ${fmtDur(child.startedAt, child.finishedAt)}`, color: child.stopReason === 'failed' ? C.red : C.faint }
    }
    return { detail: '', color: C.faint }
  }
  const copyPath = (path: string): void => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(path)
      window.setTimeout(() => setCopied(null), 1200)
    }).catch(() => { /* clipboard unavailable */ })
  }
  return createElement('div', null,
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', marginBottom: 6 } },
      createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: statusColor, flexShrink: 0 } }),
      createElement('span', { style: { fontSize: 13, color: C.text, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, run.name),
    ),
    createElement(Row, { label: 'id', value: run.id, color: C.faint }),
    createElement(Row, {
      label: 'status',
      value: run.settled ? (run.stopReason ?? 'ended') : (run.phase ?? 'running'),
      color: statusColor,
    }),
    createElement(Row, { label: 'elapsed', value: fmtDur(run.startedAt, ts), color: C.text }),
    createElement('div', { style: { color: C.faint, fontSize: 10, marginTop: 10, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } }, `Steps (${run.steps.length})`),
    run.steps.length === 0
      ? createElement('div', { style: { color: C.faint, fontSize: 11, padding: '2px 0' } }, 'no agent calls observed')
      : run.steps.map((step) => {
        const linked = stepMeta(step.childId)
        const linkable = step.childId !== undefined && subagents.some(s => s.id === step.childId)
        return createElement('div', {
          key: step.seq,
          onClick: linkable ? () => onOpenSubagent(step.childId as string) : undefined,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0',
            ...(linkable ? { cursor: 'pointer' } : {}),
          },
          title: linkable ? 'Open subagent detail' : (step.childId ?? step.label),
        },
          createElement('span', { style: { color: C.faint, fontSize: 10, minWidth: 22, fontVariantNumeric: 'tabular-nums' } }, `#${step.seq}`),
          createElement('span', {
            style: { fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
          }, step.label),
          step.phase !== undefined
            ? createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, step.phase)
            : null,
          linked.detail !== ''
            ? createElement('span', { style: { color: linked.color, fontSize: 10, flexShrink: 0 } }, linked.detail.trim())
            : null,
          step.outcome !== undefined
            ? createElement('span', { style: { color: outcomeColor(step.outcome), fontSize: 10, flexShrink: 0 } }, step.outcome)
            : null,
          linkable
            ? createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, '›')
            : null,
        )
      }),
    run.files.length > 0
      ? createElement('div', null,
        createElement('div', { style: { color: C.faint, fontSize: 10, marginTop: 10, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } }, `Files observed (${run.files.length})`),
        createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
          run.files.map((file) => createElement('span', {
            key: file,
            title: file,
            onClick: () => copyPath(file),
            style: {
              fontSize: 10, color: C.text, background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '1px 6px', maxWidth: 240, cursor: 'pointer',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, copied === file ? '✓ copied' : fileBase(file))),
        ),
      )
      : null,
  )
}

function WorkflowList(props: { state: PillState; onOpen: (run: PillWorkflowRun) => void }): JSX.Element | null {
  const { state, onOpen } = props
  const workflows = state.agent.workflows ?? []
  if (workflows.length === 0) return null
  return createElement('div', null,
    workflows.map((run) => createElement(WorkflowRow, { key: run.id, run, ts: state.ts, onOpen })),
  )
}

/* ── Root: capsule + popover ───────────────────────────────────────────── */

function PillRoot(props: { sessions: ISessions }): JSX.Element {
  const { sessions } = props
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PillState | null>(null)
  // Detail layer stack: pushed views (workflow / subagent / job) on top of
  // the main list. Back pops one level (two-level navigation: workflow
  // step → subagent → back to the workflow). Cleared on target loss or
  // session switch.
  type PillLayer = { kind: 'workflow'; id: string } | { kind: 'subagent'; id: string } | { kind: 'job'; id: string }
  const [layers, setLayers] = useState<PillLayer[]>([])
  const detail = layers.length > 0 ? (layers[layers.length - 1] ?? null) : null
  const pushLayer = (layer: PillLayer): void => {
    setLayerAnim('in')
    setLayers(prev => [...prev, layer])
  }
  const popLayer = (): void => {
    setLayerAnim('back')
    setLayers(prev => prev.slice(0, -1))
  }
  const clearLayers = (): void => {
    setLayerAnim('back')
    setLayers([])
  }
  // Animation direction for layer transitions (enter pushes from the right,
  // back slides from the left).
  const [layerAnim, setLayerAnim] = useState<'in' | 'back'>('in')
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

  // Desktop notifications on settlement transitions (tmux-agent-sidebar
  // style): workflow ended, job failed, goal completed. Each id fires once.
  // The FIRST snapshot only registers existing settled ids — nothing notifies
  // on load (a browser refresh must not replay old events).
  const notifiedRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (state === null) return
    const fire = (key: string, title: string, body: string): void => {
      if (notifiedRef.current === null) {
        // First snapshot: register only, never notify.
        return
      }
      if (notifiedRef.current.has(key)) return
      notifiedRef.current.add(key)
      notify(title, body)
    }
    for (const run of state.agent.workflows ?? []) {
      if (run.settled) {
        fire(
          `wf:${run.id}`,
          run.stopReason === 'completed' ? 'Workflow completed' : `Workflow finished (${run.stopReason ?? 'ended'})`,
          run.name,
        )
      }
    }
    for (const job of state.jobs) {
      if (job.status === 'failed') fire(`job:${job.id}`, 'Background job failed', job.label)
    }
    if (state.goal?.phase === 'complete') {
      fire(`goal:${state.goal.id}`, 'Goal completed', state.goal.objective.slice(0, 80))
    }
    if (notifiedRef.current === null) notifiedRef.current = new Set()
  }, [state])

  // Ctrl+Alt+P toggles the popover; Esc pops one layer first (detail →
  // main → close), then closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault()
        setOpen(prev => !prev)
      } else if (event.key === 'Escape') {
        setLayers(prev => {
          if (prev.length > 0) {
            setLayerAnim('back')
            return prev.slice(0, -1)
          }
          setOpen(false)
          return prev
        })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Click outside the capsule+popover closes the popover (no overlay).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Close the popover and drop every layer when switching sessions.
  useEffect(() => {
    setOpen(false)
    setLayers([])
  }, [sessionId])

  // Popover geometry: anchored to the capsule, flipped to stay in viewport.
  const capsuleRef = useRef<HTMLButtonElement>(null)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const compute = (): void => {
      const el = capsuleRef.current
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(360, window.innerWidth - 16)
      const maxHeight = Math.min(Math.floor(window.innerHeight * 0.7), window.innerHeight - 16)
      let top = rect.bottom + 8
      let left = rect.left
      // Flip up when there is not enough room below; right-align (shift
      // left) when the panel would run past the right edge.
      if (top + maxHeight > window.innerHeight - 8) top = Math.max(8, rect.top - 8 - maxHeight)
      if (left + width > window.innerWidth - 8) left = Math.max(8, rect.right - width)
      setPanelPos({ top, left })
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [open])

  // Collapsible sections, remembered in localStorage.
  const SECTION_KEY = 'dsh-agent-pill.sections'
  const loadSectionState = (): Record<string, boolean> => {
    try {
      const raw = window.localStorage.getItem(SECTION_KEY)
      if (raw === null) return {}
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const out: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') out[key] = value
      }
      return out
    } catch {
      return {}
    }
  }
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadSectionState)
  const toggleSection = (key: string): void => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !(prev[key] ?? false) }
      try { window.localStorage.setItem(SECTION_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }

  // Activity summary driving the capsule.
  const goal = state?.goal ?? null
  const goalActive = goal !== null && (goal.phase === 'active' || goal.phase === 'paused' || goal.phase === 'blocked')
  const workflows = state?.agent.workflows ?? []
  const runningWorkflow = workflows.find(run => !run.settled)
  const workflowRunning = runningWorkflow !== undefined

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
  if (workflowRunning && runningWorkflow !== undefined) counts.push({
    value: 'wf', color: C.purple,
    title: `workflow: ${runningWorkflow.name}${runningWorkflow.phase !== null ? ` · ${runningWorkflow.phase}` : ''}`,
  })
  if (failedJobs > 0) counts.push({ value: String(failedJobs), color: C.red, title: 'failed jobs' })
  if (goal !== null && goal.phase !== 'complete') {
    counts.push({ value: 'G', color: PHASE_META[goal.phase]?.color ?? C.yellow, title: `goal: ${goal.phase}` })
  }
  const inboxCount = state?.agent.inbox ?? 0
  if (inboxCount > 0) counts.push({ value: 'q', color: C.yellow, title: `${inboxCount} queued message${inboxCount > 1 ? 's' : ''}` })
  const toolName = state?.agent.tool
  const fleet = state?.agents ?? []
  const recentTools = state?.agent.recentTools ?? []
  // Resolve the top detail-layer target against the live snapshot; if it is
  // gone (list refreshed, run replaced), pop back one level.
  const detailRun = detail !== null && detail.kind === 'workflow'
    ? (state?.agent.workflows ?? []).find(run => run.id === detail.id)
    : undefined
  const detailChild = detail !== null && detail.kind === 'subagent'
    ? (state?.subagents ?? []).find(child => child.id === detail.id)
    : undefined
  const detailJob = detail !== null && detail.kind === 'job'
    ? (state?.jobs ?? []).find(job => job.id === detail.id)
    : undefined
  useEffect(() => {
    if (detail !== null && detailRun === undefined && detailChild === undefined && detailJob === undefined && state !== null) {
      popLayer()
    }
  }, [detail, detailRun, detailChild, detailJob, state])

  return createElement('div', { ref: rootRef },
    // ── Capsule (draggable; click toggles the popover) ──
    createElement('button', {
      ref: capsuleRef,
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
      title: `Agent activity (${counts.map(c => c.title).join(', ') || 'idle'})${toolName !== undefined ? ` — running ${toolName}` : ''} — drag to move, click or Ctrl+Alt+P for panel`,
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
    // ── Popover (tooltip-style, anchored to the capsule, viewport-flipped) ──
    open && panelPos !== null
      ? createElement('div', {
        style: {
          position: 'fixed', top: panelPos.top, left: panelPos.left,
          width: Math.min(360, window.innerWidth - 16),
          maxHeight: '70vh', zIndex: 2147483002,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: 'var(--pill-shadow)',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        },
      },
        createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0,
          },
        },
          detail !== null
            ? createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 } },
              createElement('button', {
                onClick: popLayer,
                'aria-label': 'Back',
                title: 'Back',
                style: { ...iconButtonStyle, fontSize: 13, padding: '2px 9px', flexShrink: 0 },
              }, '←'),
              createElement('span', {
                style: { color: C.text, fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
              }, detail.kind === 'workflow' ? (detailRun?.name ?? 'Workflow')
                : detail.kind === 'subagent' ? (detailChild?.label ?? 'Subagent')
                : (detailJob?.label ?? 'Job')),
            )
            : createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              createElement('span', { style: { width: 9, height: 9, borderRadius: 5, background: dotColor } }),
              createElement('span', { style: { color: C.text, fontSize: 13, fontWeight: 700 } }, 'Agent Activity'),
              state !== null
                ? createElement('span', { style: { color: C.faint, fontSize: 10 } }, state.sessionId)
                : null,
            ),
          createElement('button', {
            onClick: () => setOpen(false), 'aria-label': 'Close', title: 'Close (Esc / Ctrl+Alt+P)',
            style: { ...iconButtonStyle, fontSize: 13, padding: '2px 9px' },
          }, '✕'),
        ),
        // ── Scrollable body: detail layer (pushed) or the main view ──
        createElement('div', {
          key: detail === null ? 'main' : `${detail.kind}:${detail.id}`,
          className: layerAnim === 'in' ? 'pill-layer-in' : 'pill-layer-back',
          style: { flex: 1, overflowY: 'auto', padding: '4px 14px 20px' },
        },
          state === null
            ? createElement('div', { style: { color: C.faint, fontSize: 12, padding: '16px 0' } },
              sessionId === undefined ? 'No active conversation' : 'Loading…')
            : detail !== null && detail.kind === 'workflow' && detailRun !== undefined
              ? createElement(WorkflowDetail, {
                run: detailRun,
                ts: state.ts,
                subagents: state.subagents,
                onOpenSubagent: (childId) => {
                  pushLayer({ kind: 'subagent', id: childId })
                },
              })
              : detail !== null && detail.kind === 'subagent' && detailChild !== undefined
                ? createElement(SubagentDetail, {
                  child: detailChild,
                  ts: state.ts,
                  sessionId: state.sessionId,
                  onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) },
                })
                : detail !== null && detail.kind === 'job' && detailJob !== undefined
                  ? createElement(JobDetail, {
                    job: detailJob,
                    sessionId: state.sessionId,
                    ts: state.ts,
                    onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) },
                  })
                  : createElement('div', null,
              // ── Empty-state hiding (v0.6.0): a section renders only when it
              // has real content; the header above always stays. ──
              state.goal !== null
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Goal', onToggle: () => toggleSection('goal'), collapsed: collapsed.goal === true,
                  }),
                  collapsed.goal === true
                    ? null
                    : createElement(GoalCard, { state, onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) } }),
                )
                : null,
              state.agent.status !== 'absent' || state.agent.tool !== undefined || (state.agent.inbox ?? 0) > 0 || (state.agent.workflows ?? []).length > 0
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Agent', onToggle: () => toggleSection('agent'), collapsed: collapsed.agent === true,
                  }),
                  collapsed.agent === true
                    ? null
                    : createElement('div', null,
                      createElement(Row, {
                        label: 'status',
                        value: state.agent.status,
                        color: state.agent.status === 'running' ? C.yellow : state.agent.status === 'idle' ? C.green : C.faint,
                      }),
                      state.agent.tool !== undefined
                        ? createElement(Row, {
                          label: 'tool',
                          value: `${state.agent.tool}${state.agent.toolSince !== undefined ? ` · ${fmtDur(state.agent.toolSince, state.ts)}` : ''}`,
                          color: C.purple,
                        })
                        : null,
                      recentTools.length > 0
                        ? createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0 4px' } },
                          recentTools.map((t, index) => createElement('span', {
                            key: `${t.name}-${index}`,
                            style: {
                              fontSize: 10, color: C.dim, background: C.bg, border: `1px solid ${C.border}`,
                              borderRadius: 4, padding: '1px 6px', maxWidth: 200,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            },
                            title: `${t.name} · ${fmtDur(Date.now() - t.durationMs, Date.now())}`,
                          }, `${t.name} · ${fmtDur(Date.now() - t.durationMs, Date.now())}`)),
                        )
                        : null,
                      state.agent.inbox !== undefined && state.agent.inbox > 0
                        ? createElement(Row, {
                          label: 'queued',
                          value: `${state.agent.inbox} message${state.agent.inbox > 1 ? 's' : ''} waiting`,
                          color: C.yellow,
                        })
                        : null,
                      createElement(WorkflowList, {
                        state,
                        onOpen: (run) => pushLayer({ kind: 'workflow', id: run.id }),
                      }),
                    ),
                )
                : null,
              state.subagents.filter(s => s.kind === 'child').length > 0 || state.subagents.some(s => s.kind === 'diagnostic')
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Subagents',
                    count: state.subagents.filter(s => s.kind === 'child').length,
                    onToggle: () => toggleSection('subagents'), collapsed: collapsed.subagents === true,
                  }),
                  collapsed.subagents === true
                    ? null
                    : createElement(SubagentList, {
                      state,
                      onAction: () => { void api.state(state.sessionId, undefined).then(setState).catch(() => {}) },
                      onOpen: (child) => pushLayer({ kind: 'subagent', id: child.id }),
                    }),
                )
                : null,
              state.jobs.length > 0
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Jobs', count: state.jobs.length,
                    onToggle: () => toggleSection('jobs'), collapsed: collapsed.jobs === true,
                  }),
                  collapsed.jobs === true
                    ? null
                    : createElement(JobList, {
                      state,
                      onOpen: (job) => pushLayer({ kind: 'job', id: job.id }),
                    }),
                )
                : null,
              state.services.usage && state.usage !== undefined
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Usage', onToggle: () => toggleSection('usage'), collapsed: collapsed.usage === true,
                  }),
                  collapsed.usage === true
                    ? null
                    : createElement('div', null,
                      // Context pressure bar (claude-statusline style):
                      // threshold colors, rainbow at very high usage. The
                      // denominator is the real model window when resolved.
                      (() => {
                        const window = state.usage.contextWindow ?? EST_CONTEXT_WINDOW
                        const ratio = Math.min(1, state.usage.totalTokens / window)
                        const barColor = ratio > 0.95
                          ? 'linear-gradient(90deg,#e05a5a,#d9a13b,#3fb96a,#5a9cf0,#a37de8,#e05a5a)'
                          : ratio > 0.85 ? C.red
                          : ratio > 0.6 ? C.yellow
                          : C.green
                        return createElement('div', {
                          style: { margin: '4px 0 6px', height: 6, borderRadius: 3, background: C.bg, overflow: 'hidden' },
                          title: `${Math.round(ratio * 100)}% of ${state.usage.contextWindow !== undefined ? fmtTokens(state.usage.contextWindow) : `~${fmtTokens(EST_CONTEXT_WINDOW)} (assumed)`} context window`,
                        },
                          createElement('div', {
                            style: {
                              height: '100%', width: `${Math.round(ratio * 100)}%`,
                              background: barColor, borderRadius: 3,
                            },
                          }),
                        )
                      })(),
                      createElement(Row, { label: 'pressure', value: fmtTokens(state.usage.totalTokens), color: C.text }),
                      createElement(Row, { label: 'surface', value: fmtTokens(state.usage.surfaceTokens), color: C.text }),
                      createElement(Row, {
                        label: 'delta',
                        value: fmtTokens(state.usage.surfaceDeltaTokens),
                        color: state.usage.surfaceDeltaTokens >= 0 ? C.text : C.green,
                      }),
                      state.consumed !== undefined
                        ? createElement(Row, {
                          label: 'cost',
                          value: `~$${estimateCostUsd(state.consumed).toFixed(2)} · ${fmtTokens(
                            state.consumed.input + state.consumed.cacheRead + state.consumed.cacheWrite + state.consumed.output,
                          )} tok${priceMultiplier() > 1 ? ' · peak' : ' · off-peak'}`,
                          color: priceMultiplier() > 1 ? C.yellow : C.text,
                        })
                        : null,
                    ),
                )
                : null,
              fleet.length > 0
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Sessions', count: fleet.length,
                    onToggle: () => toggleSection('sessions'), collapsed: collapsed.sessions === true,
                  }),
                  collapsed.sessions === true
                    ? null
                    : fleet.map((entry) => {
                      const active = entry.status === 'running'
                      return createElement('div', {
                        key: entry.id,
                        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
                      },
                        createElement('span', {
                          style: { width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: active ? C.yellow : C.faint },
                        }),
                        createElement('span', {
                          style: { fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
                          title: entry.id,
                        }, entry.id.slice(0, 22)),
                        entry.goal !== undefined
                          ? createElement('span', {
                            style: { fontSize: 10, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 },
                            title: entry.goal,
                          }, entry.goal)
                          : null,
                      )
                    }),
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
