import { defineConfig } from 'tsdown'

/**
 * Main and worker are ordinary Node ESM. The sandboxed preload is a standalone
 * CommonJS bundle because Electron gives sandboxed preloads its small
 * `require` facade rather than treating them as package ESM.
 */
export default defineConfig([
  {
    entry: ['lib/types/main.js', 'lib/types/harness-worker.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    deps: { neverBundle: ['electron'] },
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    deps: { neverBundle: ['electron'] },
    outExtensions: () => ({ js: '.cjs' }),
    dts: false,
    clean: false,
  },
])
