/**
 * Client half of dsh-agent-pill: mounts the top-right activity capsule and
 * the right summary drawer into the page body (a cross-session, shell-corner
 * surface with no dedicated slot seat), and toggles it with Ctrl+Alt+P.
 * The bundle is a module-table consumer only (react + react-dom/client are
 * platform modules resolved through the loader's injected require).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { Context } from '@deepseek-ai/cordis'
import { PillRoot, PILL_CSS } from './Pill.tsx'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['sessions']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (sessions).
 */
export function apply(ctx: Context): void {
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
      root.render(createElement(PillRoot, { sessions: ctx.sessions }))
    } catch (error) {
      console.error('[dsh-agent-pill] mount error:', error)
    }
    return () => {
      root?.unmount()
      host?.remove()
      style.remove()
    }
  }, 'dsh-agent-pill: mount')
}
