/**
 * tsdown config for the dsh-agent-pill client bundle.
 *
 * Emits the DSH client-bundle protocol artifact (see the official preset
 * `packages/client/tsdown.client.ts` in deepseek-harness): a CJS
 * closure-factory that calls `window.__ModuleLoader__.load({id, factory})`,
 * with platform modules resolved through the loader's injected require and
 * every other dependency inlined into the factory.
 */
import { defineConfig } from 'tsdown'

/** The module specifiers the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** Documented temporary exemption: the snapshot-store engine rides runtime. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

export default defineConfig({
  name: 'dsh-agent-pill/client',
  // tsc (tsconfig.client.json) emits the browser half to lib/types/client/.
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Everything not on the frozen module table must inline: a require() the
  // table cannot answer is a guaranteed runtime throw.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-agent-pill", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
