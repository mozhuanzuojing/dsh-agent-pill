/**
 * Client half of dsh-agent-pill: the capsule (dock toggle), the composer
 * dock strip (live per-session activity) and the turn-tail file rows (files
 * each instruction handled, with inline diffs). All three share one
 * module-level pill store; the capsule remains a shell-corner surface.
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { Context } from '@deepseek-ai/cordis'
import { PillRoot, PILL_CSS, TurnTailFiles } from './Pill.tsx'
import { pillStore, startPillStore } from './store.ts'

// SlotMap augmentation for the one seat this plugin occupies. Kept local to
// avoid depending on the conversation package's private contract files.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.chat.turnTail': {
      kind: 'chain'
      scope: 'session'
      owner: { turn: unknown; seq: number; openFile: (path: string) => void }
    }
  }
}

/** Services required before mounting (provided by the client runtime). */
export const inject = ['sessions', 'slots']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (sessions, slots).
 */
export function apply(ctx: Context): void {
  // The shared polling store (idempotent; session comes from the list feed).
  startPillStore(() => {
    const current = (ctx.sessions.list as { getSnapshot?: () => { current?: string } }).getSnapshot?.()?.current
    return typeof current === 'string' ? current : undefined
  })

  ctx.effect(() => {
    let root: Root | undefined
    let host: HTMLDivElement | undefined
    // The theme palette stylesheet: lives for this fiber, removed on HMR
    // disposal so a re-activation re-registers it cleanly.
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-agent-pill'
    style.textContent = PILL_CSS
    document.head.appendChild(style)
    try {
      host = document.createElement('div')
      host.setAttribute('data-dsh-agent-pill', '')
      document.body.appendChild(host)
      root = createRoot(host)
      root.render(createElement(PillRoot))
    } catch (error) {
      console.error('[dsh-agent-pill] mount error:', error)
    }
    return () => {
      root?.unmount()
      host?.remove()
      style.remove()
    }
  }, 'dsh-agent-pill: mount')

  // Turn-tail file rows: the files each instruction handled.
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: () => ({}),
    inject: () => ({}),
  }, TurnTailFiles)), 'dsh-agent-pill: turn tail')

  // Esc closes the console popover; Ctrl+Alt+P toggles it.
  ctx.effect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault()
        pillStore.toggleConsole()
      } else if (event.key === 'Escape' && pillStore.getConsoleOpen()) {
        pillStore.setConsoleOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, 'dsh-agent-pill: keys')
}
