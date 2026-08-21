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
import { api, PillApiError, type PillActivityEvent, type PillFileDiff, type PillJob, type PillState, type PillSubagent, type PillTurn, type PillWorkflowRun } from './api.ts'
import { pillStore } from './store.ts'

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

/** HH:MM:SS clock for timeline rows and capsule tooltips. */
function fmtTimeOf(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
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

const ROUND_END_META: Record<string, { label: string; color: string }> = {
  completed: { label: '✓', color: C.green },
  aborted: { label: '⏹', color: C.dim },
  blocked: { label: '⏸', color: C.yellow },
  error: { label: '✗', color: C.red },
}

/** ZCode-style round list: one row per turn (title, tool count, end state, files). */
function RoundList(props: { turns: PillTurn[]; now: number }): JSX.Element {
  const { turns, now } = props
  return createElement('div', null,
    turns.map(turn => {
      const open = turn.endedAt === null
      const endMeta = open
        ? { label: '…', color: C.yellow }
        : ROUND_END_META[turn.endReason ?? ''] ?? { label: '·', color: C.faint }
      return createElement('div', {
        key: turn.turn,
        style: {
          marginBottom: 8,
          paddingLeft: 8,
          borderLeft: `2px solid ${open ? C.yellow : C.faint}`,
          ...(open ? { background: 'rgba(217,161,59,0.06)', borderRadius: 4 } : {}),
        },
      },
        createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '1px 0' } },
          createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, `#${turn.turn}`),
          createElement('span', {
            style: { fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
            title: turn.title,
          }, turn.title),
          turn.tools > 0
            ? createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, `⚙${turn.tools}`)
            : null,
          createElement('span', { style: { color: endMeta.color, fontSize: 10, flexShrink: 0 } }, endMeta.label),
        ),
        turn.files.length > 0
          ? createElement('div', { style: { marginTop: 2 } },
            turn.files.map(file => createElement(FileRow, { key: file.path, diff: file, now })))
          : null,
      )
    }),
  )
}

function GoalCard(props: { state: PillState; onAction: () => void }): JSX.Element {
  const { state, onAction } = props
  const goal = state.goal
  if (goal === null) {
    return createElement('div', { style: { color: C.faint, fontSize: 12, padding: '4px 0' } }, 'No goal set')
  }
  const meta = PHASE_META[goal.phase] ?? { color: C.yellow, label: 'active' }
  const disabled = goal.phase === 'complete'
  const turns = state.turns ?? []
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
    turns.length > 0
      ? createElement('div', { style: { marginTop: 8 } },
        createElement('div', { style: { color: C.faint, fontSize: 10, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' } },
          'Rounds'),
        createElement(RoundList, { turns, now: state.ts }),
      )
      : null,
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
        // Identity dot: running → yellow, else the stable identity color.
        createElement('span', {
          style: {
            width: 7, height: 7, borderRadius: 4, flexShrink: 0,
            background: child.activity === 'running' ? C.yellow : (child.color || C.faint),
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
function SubagentDetail(props: {
  child: PillSubagent
  ts: number
  sessionId: string
  workflows: PillWorkflowRun[]
  fileDiffs: PillFileDiff[]
  onOpenWorkflow: (run: PillWorkflowRun) => void
  onAction: () => void
}): JSX.Element {
  const { child, ts, sessionId, workflows, fileDiffs, onOpenWorkflow, onAction } = props
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
  // Linkage (v0.12.0): which workflow step ran this child, and that
  // workflow's touched files (matching the child session id).
  const linkedStep = workflows.flatMap(run =>
    run.steps
      .filter(step => step.childId === child.id)
      .map(step => ({ run, step })),
  )[0]
  const linkedFiles = linkedStep !== undefined
    ? linkedStep.run.files
        .map(file => fileDiffs.find(d => d.path === file)
          ?? fileDiffs.find(d => (d.path.split(/[\\/]/).pop() ?? d.path) === (file.split(/[\\/]/).pop() ?? file)))
        .filter((d): d is PillFileDiff => d !== undefined)
    : []
  return createElement('div', null,
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', marginBottom: 6 } },
      createElement('span', {
        style: {
          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
          background: child.activity === 'running' ? C.yellow : (child.color || C.faint),
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
    linkedStep !== undefined
      ? createElement('div', null,
        createElement('div', { style: { color: C.faint, fontSize: 10, marginTop: 12, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } }, 'Workflow step'),
        createElement('div', {
          onClick: () => onOpenWorkflow(linkedStep.run),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', cursor: 'pointer',
            borderRadius: 6, background: C.panel2, border: `1px solid ${C.border}`,
          },
          title: linkedStep.run.id,
        },
          createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, `#${linkedStep.step.seq}`),
          createElement('span', {
            style: { fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
          }, linkedStep.run.name),
          linkedStep.step.phase !== undefined
            ? createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, linkedStep.step.phase)
            : null,
          linkedStep.step.outcome !== undefined
            ? createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, linkedStep.step.outcome)
            : null,
          createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, '›'),
        ),
        linkedFiles.length > 0
          ? createElement('div', null,
            createElement('div', { style: { color: C.faint, fontSize: 10, marginTop: 8, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } }, 'Workflow files'),
            linkedFiles.map(file => createElement(FileRow, { key: file.path, diff: file, now: Date.now() })),
          )
          : null,
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
    run.files.length > 0
      ? createElement('span', {
        style: {
          fontSize: 10, color: C.purple, border: `1px solid ${C.purple}`, borderRadius: 4,
          padding: '0 5px', lineHeight: '15px', flexShrink: 0,
        },
        title: `${run.files.length} file${run.files.length > 1 ? 's' : ''}`,
      }, `📄${run.files.length}`)
      : null,
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
  fileDiffs: PillFileDiff[]
}): JSX.Element {
  const { run, ts, subagents, onOpenSubagent, fileDiffs } = props
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
        createElement('div', { style: { color: C.faint, fontSize: 10, marginTop: 10, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } }, `Files (${run.files.length})`),
        run.files.map((file) => {
          // The fs feed reports absolute display paths, while tool/result
          // diffs carry the model-facing path (relative to the workspace) —
          // match exactly first, then by basename.
          const base = file.split(/[\\/]/).pop() ?? file
          const diff = fileDiffs.find(d => d.path === file)
            ?? fileDiffs.find(d => (d.path.split(/[\\/]/).pop() ?? d.path) === base)
          if (diff === undefined) {
            // File observed but no collected diff (read-only activity).
            return createElement('div', { key: file, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px' } },
              createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, '·'),
              createElement('span', {
                style: { fontSize: 11, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
                title: file,
              }, fileBase(file)),
            )
          }
          return createElement(FileRow, { key: file, diff, now: ts })
        }),
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

/* ── File detail: diff rendering ───────────────────────────────────────── */

/** Simple line-level diff (common prefix/suffix + middle multiset match). */
function diffLines(oldText: string | null, newText: string): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const rows: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  if (oldText === null) {
    for (const line of newText.split('\n')) rows.push({ type: 'add', text: line })
    return rows
  }
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const count = new Map<string, number>()
  for (const line of midA) count.set(line, (count.get(line) ?? 0) + 1)
  const used = new Map<string, number>()
  for (const line of midB) {
    const total = count.get(line) ?? 0
    const consumed = used.get(line) ?? 0
    if (consumed < total) {
      used.set(line, consumed + 1)
      rows.push({ type: 'same', text: line })
    } else {
      rows.push({ type: 'add', text: line })
    }
  }
  for (const line of midA) {
    const total = count.get(line) ?? 0
    const consumed = used.get(line) ?? 0
    if (consumed < total) {
      used.set(line, consumed + 1)
      rows.push({ type: 'del', text: line })
    }
  }
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  for (let i = 0; i < prefix; i++) out.push({ type: 'same', text: a[i] ?? '' })
  for (const row of rows) out.push(row)
  for (let i = 0; i < suffix; i++) out.push({ type: 'same', text: a[a.length - suffix + i] ?? '' })
  return out
}

/** Count add/del lines for the +/- badge. */
function diffCounts(diff: { oldText: string | null; newText: string }): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of diffLines(diff.oldText, diff.newText)) {
    if (row.type === 'add') added++
    else if (row.type === 'del') removed++
  }
  return { added, removed }
}

/** One file row inside a workflow detail: name + +/- badge, inline diff. */
const GIT_META: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: C.yellow },
  A: { label: 'A', color: C.green },
  D: { label: 'D', color: C.red },
  R: { label: 'R', color: C.purple },
  '?': { label: '?', color: C.faint },
}

function FileRow(props: { diff: PillFileDiff; now: number }): JSX.Element {
  const { diff, now } = props
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState(false)
  const [copied, setCopied] = useState(false)
  // Git working-tree marker for this path (host aggregates `git status`;
  // diff paths may be absolute while porcelain is cwd-relative, so fall
  // back to a basename match like the workflow-file linkage does).
  const gitState = useSyncExternalStore(
    useMemo(() => (cb: () => void) => pillStore.subscribe(cb), []),
    useMemo(() => () => pillStore.getState(), []),
  )
  const gitStatus = gitState?.gitStatus
  const gitMarker = gitStatus?.[diff.path] ?? (gitStatus !== undefined
    ? Object.entries(gitStatus).find(([p]) => (p.split(/[\\/]/).pop() ?? p) === (diff.path.split(/[\\/]/).pop() ?? diff.path))?.[1]
    : undefined)
  const gitMeta = gitMarker !== undefined ? GIT_META[gitMarker] : undefined
  const fileBase = diff.path.split(/[\\/]/).pop() ?? diff.path
  const counts = diffCounts(diff)
  const copyPath = (): void => {
    void navigator.clipboard.writeText(diff.path).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }).catch(() => { /* clipboard unavailable */ })
  }
  const rows = diffLines(diff.oldText, diff.newText)
  const visible = context ? rows : rows.filter(row => row.type !== 'same')
  return createElement('div', { style: { marginBottom: 2 } },
    createElement('div', {
      onClick: () => setExpanded(prev => !prev),
      title: diff.path,
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', cursor: 'pointer', borderRadius: 4 },
    },
      createElement('span', { style: { color: C.faint, fontSize: 10, flexShrink: 0 } }, expanded ? '▾' : '▸'),
      gitMeta !== undefined
        ? createElement('span', {
          style: { color: gitMeta.color, fontSize: 10, flexShrink: 0, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
        }, gitMeta.label)
        : null,
      createElement('span', {
        style: { fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      }, fileBase),
      counts.added > 0
        ? createElement('span', { style: { color: C.green, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, `+${counts.added}`)
        : null,
      counts.removed > 0
        ? createElement('span', { style: { color: C.red, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, `-${counts.removed}`)
        : null,
      createElement('button', {
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation()
          copyPath()
        },
        'aria-label': 'Copy path',
        title: 'Copy full path',
        style: iconButtonStyleSmall,
      }, copied ? '✓' : 'copy'),
    ),
    expanded
      ? createElement('div', {
        style: {
          margin: '2px 0 6px 18px', padding: 6, background: C.bg, border: `1px solid ${C.border}`,
          borderRadius: 5, overflowX: 'auto',
        },
      },
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 4 } },
          createElement('button', {
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              setContext(prev => !prev)
            },
            style: iconButtonStyleSmall,
          }, context ? 'changes only' : 'with context'),
        ),
        visible.length === 0
          ? createElement('div', { style: { color: C.faint, fontSize: 10 } }, '(no line changes)')
          : createElement('pre', { style: { margin: 0, fontSize: 11, lineHeight: 1.45 } },
            visible.map((row, index) => createElement('div', {
              key: index,
              style: {
                color: row.type === 'add' ? C.green : row.type === 'del' ? C.red : C.dim,
                background: row.type === 'add' ? 'rgba(63,185,106,0.08)' : row.type === 'del' ? 'rgba(224,90,90,0.08)' : 'transparent',
                whiteSpace: 'pre',
              },
            }, `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`)),
          ),
      )
      : null,
    createElement('div', { style: { color: C.faint, fontSize: 9, margin: '0 0 4px 18px' } },
      `${fmtAgo(diff.ts, now)} ago`),
  )
}

/** Activity timeline ("eyes on the internals"): newest first event feed. */
function ActivityList(props: { timeline: PillActivityEvent[] }): JSX.Element {
  const { timeline } = props
  const META: Record<string, { icon: string; color: string }> = {
    tool: { icon: '⛭', color: C.blue },
    'tool-done': { icon: '✓', color: C.green },
    file: { icon: '✎', color: C.purple },
    workflow: { icon: '⚙', color: C.purple },
    subagent: { icon: '▸', color: C.blue },
    goal: { icon: '🎯', color: C.yellow },
  }
  return createElement('div', null,
    timeline.map((event, index) => {
      const meta = META[event.kind] ?? { icon: '·', color: C.faint }
      const suffix = (event.count !== undefined && event.count > 1 ? ` ×${event.count}` : '')
        + (event.detail !== undefined ? ` · ${event.detail}` : '')
      return createElement('div', {
        key: index,
        style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0' },
      },
        createElement('span', {
          style: { color: C.faint, fontSize: 9, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
        }, fmtTimeOf(event.ts)),
        createElement('span', { style: { color: meta.color, fontSize: 11, flexShrink: 0 } }, meta.icon),
        createElement('span', {
          style: { fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
          title: event.detail ?? event.text,
        }, event.text + suffix),
      )
    }),
  )
}

/* ── Root: capsule + popover ───────────────────────────────────────────── */

function PillRoot(): JSX.Element {
  // Console popover visibility lives in the shared store (dock toggles it).
  const consoleOpen = useSyncExternalStore(
    useMemo(() => (cb: () => void) => pillStore.subscribe(cb), []),
    useMemo(() => () => pillStore.getConsoleOpen(), []),
  )
  const state = useSyncExternalStore(
    useMemo(() => (cb: () => void) => pillStore.subscribe(cb), []),
    useMemo(() => () => pillStore.getState(), []),
  )
  const sessionId = useSyncExternalStore(
    useMemo(() => (cb: () => void) => pillStore.subscribe(cb), []),
    useMemo(() => () => pillStore.getSessionId(), []),
  )
  // Detail layer stack: pushed views (workflow / subagent / job).
  type PillLayer =
    | { kind: 'workflow'; id: string }
    | { kind: 'subagent'; id: string }
    | { kind: 'job'; id: string }
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
  // Animation direction for layer transitions (enter pushes from the right,
  // back slides from the left).
  const [layerAnim, setLayerAnim] = useState<'in' | 'back'>('in')

  // ── Capsule drag ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadCapsulePos)
  const [dragging, setDragging] = useState(false)
  const posRef = useRef(pos)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)
  // One-shot suppression of the click that follows a drag end (a drag must
  // not toggle the dock); consumed by onClick, never left dangling.
  const suppressClickRef = useRef(false)

  // Close the console and drop every layer when switching sessions.
  useEffect(() => {
    pillStore.setConsoleOpen(false)
    setLayers([])
  }, [sessionId])

  // Desktop notifications on settlement transitions (tmux-agent-sidebar
  // style): workflow ended, job failed, goal completed. Each id fires once.
  // The FIRST snapshot only REGISTERS existing settled ids — nothing notifies
  // on load (a browser refresh must not replay old events). The Set must be
  // created before the scan so first-snapshot ids are recorded; only later
  // snapshots that see a settled id for the first time fire a notification.
  const notifiedRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (state === null) return
    const first = notifiedRef.current === null
    if (first) notifiedRef.current = new Set()
    const seen = notifiedRef.current!
    const fire = (key: string, title: string, body: string): void => {
      if (seen.has(key)) return
      seen.add(key)
      if (!first) notify(title, body)
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
  }, [state])

  // Click outside the capsule+console closes the console (no overlay).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!consoleOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        pillStore.setConsoleOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [consoleOpen])

  // Popover geometry: anchored to the capsule, flipped to stay in viewport.
  const capsuleRef = useRef<HTMLButtonElement>(null)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  // Adaptive width (v0.9.0, enlarged v0.14.3): the popover follows its
  // content's natural width ×1.5 (a 50% increase), clamped between 480 and
  // min(780, viewport-16); diff rows keep their width. The observer watches
  // a max-content content wrapper (workflow details only, where long diff
  // rows live), so expanding a diff widens the popover; other views keep
  // the block layout and wrap normally.
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [panelWidth, setPanelWidth] = useState(540)
  useEffect(() => {
    if (!consoleOpen) return
    const el = contentRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => {
      const natural = (el.scrollWidth + 28) * 1.5
      const next = Math.min(Math.max(natural, 480), 780, window.innerWidth - 16)
      setPanelWidth(prev => (Math.abs(prev - next) > 4 ? next : prev))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [consoleOpen, detail])
  useEffect(() => {
    if (!consoleOpen) return
    const compute = (): void => {
      const el = capsuleRef.current
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const width = panelWidth
      const maxHeight = Math.min(Math.floor(window.innerHeight * 0.7), window.innerHeight - 16)
      let top = rect.bottom + 8
      // Horizontally center the panel on the capsule, clamped to the viewport.
      let left = rect.left + rect.width / 2 - width / 2
      // Flip up when there is not enough room below.
      if (top + maxHeight > window.innerHeight - 8) top = Math.max(8, rect.top - 8 - maxHeight)
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width)
      if (left < 8) left = 8
      setPanelPos({ top, left })
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [consoleOpen, panelWidth])

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
  // Capsule body = the latest activity event while anything is busy
  // (v0.11.0 "single latest"); fully idle shrinks to a bare dot (v0.13.0
  // experiment). The dot color follows the SAME condition as the capsule
  // body, so the two can never disagree (a paused goal keeps the capsule
  // strip visible — the dot turns yellow with it, not green).
  // NOTE: the in-flight signal is `toolSince` (host clears it on tool/result);
  // `agent.tool` alone would keep the capsule busy forever after the first
  // tool call, so the shrink-to-dot experiment would never trigger.
  const capsuleBusy = state !== null && (
    agentRunning || state.agent.toolSince !== undefined
    || state.subagents.some(s => s.kind === 'child' && s.activity === 'running')
    || state.jobs.some(j => j.status === 'running' || j.status === 'stopping')
    || (state.goal !== null && state.goal.phase === 'active')
    || (state.agent.workflows ?? []).some(run => !run.settled)
    || state.agent.pendingApproval !== undefined
  )
  const dotColor = state === null ? C.faint
    : goal?.phase === 'blocked' ? C.red
    : capsuleBusy ? C.yellow
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
  const timeline = state?.timeline ?? []
  const latestEvent = timeline[0]
  const eventText = latestEvent !== undefined
    ? latestEvent.text.replace(/^tool /, '') + (latestEvent.detail !== undefined ? ` · ${latestEvent.detail}` : '')
    : ''
  const pendingApproval = state?.agent.pendingApproval
  const currentTurn = state?.currentTurn
  // v0.14.0: capsule text = ⏳ approval (needs the user) → 第N轮 · action
  // (round progress) → latest event → AGENT.
  const capsuleLabel = pendingApproval !== undefined
    ? `⏳ ${pendingApproval.toolName}`
    : latestEvent !== undefined && capsuleBusy
      ? `${currentTurn !== undefined ? `第${currentTurn}轮 · ` : ''}${ACTIVITY_ICON[latestEvent.kind] ?? '·'} ${eventText}`
      : 'AGENT'
  const capsuleTitle = pendingApproval !== undefined
    ? `Waiting for approval: ${pendingApproval.toolName}`
    : latestEvent !== undefined
      ? `${fmtTimeOf(latestEvent.ts)} ${latestEvent.text}${latestEvent.detail !== undefined ? ` · ${latestEvent.detail}` : ''}${latestEvent.count !== undefined && latestEvent.count > 1 ? ` ×${latestEvent.count}` : ''}`
      : capsuleBusy ? 'Agent activity — busy'
      : currentTurn !== undefined
        ? `第${currentTurn}轮完成${goal !== null ? ` · 目标${goal.phase}` : ''}`
        : 'Agent activity — idle'
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
    // ── Capsule (draggable; click toggles the composer dock strip) ──
    createElement('button', {
      ref: capsuleRef,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        // The click immediately following a drag end must not toggle.
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          event.preventDefault()
          return
        }
        pillStore.toggleConsole()
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
      title: pendingApproval !== undefined
        ? `⏳ Awaiting approval: ${pendingApproval.toolName} — click to review`
        : `Agent activity (${counts.map(c => c.title).join(', ') || (capsuleBusy ? 'busy' : 'idle')})${toolName !== undefined && (state?.agent.toolSince !== undefined) ? ` — running ${toolName}` : ''} — drag to move, click or Ctrl+Alt+P for panel`,
      'aria-label': 'Agent activity',
      'aria-pressed': consoleOpen,
      style: {
        position: 'fixed', zIndex: 2147483001,
        ...(pos === null ? { top: 14, right: 14 } : { top: pos.y, left: pos.x }),
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: 999,
        // v0.13.0: idle shrinks to a dot (experiment); busy shows the full strip.
        padding: capsuleBusy ? '6px 12px' : '4px', cursor: dragging ? 'grabbing' : 'grab',
        boxShadow: 'var(--pill-shadow)',
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
      },
    },
      createElement('span', {
        style: {
          width: capsuleBusy ? 9 : 8, height: capsuleBusy ? 9 : 8,
          borderRadius: 5, background: dotColor, flexShrink: 0,
          boxShadow: `0 0 ${capsuleBusy ? 6 : 10}px ${dotColor}`,
        },
      }),
      // Live label (v0.8.0): workflow "name·phase" → current tool → AGENT.
      capsuleBusy
        ? createElement('span', {
          style: {
            color: C.text, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em',
            maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
          title: capsuleTitle,
        }, capsuleLabel)
        : null,
      capsuleBusy && goal !== null && goal.phase !== 'complete'
        ? createElement('span', {
          style: { color: C.faint, fontSize: 10, fontVariantNumeric: 'tabular-nums' },
          title: `goal running for ${fmtDur(goal.createdAt, state?.ts ?? Date.now())}`,
        }, `⏱ ${fmtDur(goal.createdAt, state?.ts ?? Date.now())}`)
        : null,
      capsuleBusy && counts.map((count, index) => createElement('span', {
        key: index,
        style: {
          minWidth: 16, height: 16, borderRadius: 8, background: count.color, color: 'var(--pill-badge-text)',
          fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', padding: '0 5px',
        },
        title: count.title,
      }, count.value)),
    ),
    // ── Console popover (tooltip-style, anchored to the capsule, viewport-flipped) ──
    consoleOpen && panelPos !== null
      ? createElement('div', {
        style: {
          position: 'fixed', top: panelPos.top, left: panelPos.left,
          width: panelWidth,
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
            onClick: () => pillStore.setConsoleOpen(false), 'aria-label': 'Close', title: 'Close (Esc / Ctrl+Alt+P)',
            style: { ...iconButtonStyle, fontSize: 13, padding: '2px 9px' },
          }, '✕'),
        ),
        // ── Scrollable body: job detail layer (pushed) or the console view ──
        createElement('div', {
          key: detail === null ? 'main' : `${detail.kind}:${detail.id}`,
          ref: bodyRef,
          className: layerAnim === 'in' ? 'pill-layer-in' : 'pill-layer-back',
          style: { flex: 1, overflowY: 'auto', padding: '4px 14px 20px' },
        },
          createElement('div', {
            ref: contentRef,
            style: { minWidth: '100%' },
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
                fileDiffs: state.fileDiffs ?? [],
              })
              : detail !== null && detail.kind === 'subagent' && detailChild !== undefined
                ? createElement(SubagentDetail, {
                  child: detailChild,
                  ts: state.ts,
                  sessionId: state.sessionId,
                  workflows: state.agent.workflows ?? [],
                  fileDiffs: state.fileDiffs ?? [],
                  onOpenWorkflow: (run) => {
                    setLayerAnim('in')
                    setLayers(prev => [...prev, { kind: 'workflow', id: run.id }])
                  },
                  onAction: () => { /* store polling refreshes automatically */ },
                })
                : detail !== null && detail.kind === 'job' && detailJob !== undefined
                  ? createElement(JobDetail, {
                    job: detailJob,
                    sessionId: state.sessionId,
                    ts: state.ts,
                    onAction: () => { /* store polling refreshes automatically */ },
                  })
                  : createElement('div', null,
              // ── Console (v0.11.0): activity timeline first, then the
              // four control sections. ──
              timeline.length > 0
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Activity', count: timeline.length,
                    onToggle: () => toggleSection('activity'), collapsed: collapsed.activity === true,
                  }),
                  collapsed.activity === true
                    ? null
                    : createElement(ActivityList, { timeline }),
                )
                : null,
              (state.agent.workflows ?? []).length > 0
                ? createElement('div', null,
                  createElement(Section, {
                    title: 'Workflow', count: (state.agent.workflows ?? []).length,
                    onToggle: () => toggleSection('workflow'), collapsed: collapsed.workflow === true,
                  }),
                  collapsed.workflow === true
                    ? null
                    : createElement(WorkflowList, {
                      state,
                      onOpen: (run) => pushLayer({ kind: 'workflow', id: run.id }),
                    }),
                )
                : null,
              state.subagents.filter(s => s.kind === 'child').length > 0
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
                      onAction: () => { /* store polling refreshes automatically */ },
                      onOpen: (child) => pushLayer({ kind: 'subagent', id: child.id }),
                    }),
                )
                : null,
              state.goal !== null
                ? createElement('div', { id: 'pill-sec-goal' },
                  createElement(Section, {
                    title: 'Goal', onToggle: () => toggleSection('goal'), collapsed: collapsed.goal === true,
                  }),
                  collapsed.goal === true
                    ? null
                    : createElement(GoalCard, { state, onAction: () => { /* store polling refreshes automatically */ } }),
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
              !state.services.goals || !state.services.subagents || !state.services.jobs
                ? createElement('div', {
                  style: { marginTop: 14, color: C.faint, fontSize: 10, lineHeight: 1.5 },
                }, `Optional services: goals=${state.services.goals ? 'on' : 'off'} · subagents=${state.services.subagents ? 'on' : 'off'} · jobs=${state.services.jobs ? 'on' : 'off'}`)
                : null,
            ),
          ),
        ),
      )
      : null,
  )
}

const ACTIVITY_ICON: Record<string, string> = {
  tool: '⛭',
  'tool-done': '✓',
  file: '✎',
  workflow: '⚙',
  subagent: '▸',
  goal: '🎯',
}

/* ── Turn-tail file rows (conversation.chat.turnTail) ──────────────────── */

/**
 * Under each instruction (turn) the files that instruction handled, with
 * inline diffs (Claude Code "files changed" pattern). The owner carries the
 * turn location; files come from the shared store's per-turn aggregation.
 * Loose props: the runtime composes the owner face; we only need the turn
 * number off the chat node data.
 */
export function TurnTailFiles(props: any): JSX.Element | null {
  const state = useSyncExternalStore(
    useMemo(() => (cb: () => void) => pillStore.subscribe(cb), []),
    useMemo(() => () => pillStore.getState(), []),
  )
  // The chain owner carries the engine-owned TurnLocation ({turn: number}).
  const owner = props.owner as { turn?: { turn?: unknown } } | undefined
  const turn = typeof owner?.turn?.turn === 'number' ? owner.turn.turn : undefined
  if (state === null || turn === undefined) return null
  const turns = state.turns ?? []
  const entry = turns.find(t => t.turn === turn)
  if (entry === undefined || entry.files.length === 0) return null
  return createElement('div', {
    style: { padding: '2px 0 6px', marginTop: 2 },
  },
    createElement('div', { style: { color: C.faint, fontSize: 10, marginBottom: 3, textTransform: 'uppercase' as const, letterSpacing: '0.06em' } },
      `Files changed (${entry.files.length})`),
    entry.files.map(file => createElement(FileRow, { key: file.path, diff: file, now: Date.now() })),
  )
}

export { PillRoot }
