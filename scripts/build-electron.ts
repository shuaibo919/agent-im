import { build } from 'esbuild'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

async function buildElectron() {
  console.log('Building Electron files...')

  // 1. Electron main + preload (no bundle — they import from electron)
  await build({
    entryPoints: [
      path.join(root, 'electron/main.ts'),
      path.join(root, 'electron/preload.ts'),
    ],
    bundle: false,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outdir: path.join(root, 'dist-electron'),
    outExtension: { '.js': '.cjs' },
  })

  // 2. Orchestrator entry — bundle into single file (includes orchestrator.ts + detect-agents.ts)
  await build({
    entryPoints: [path.join(root, 'scripts/orchestrator-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(root, 'dist-electron/orchestrator-entry.cjs'),
    external: [],
  })

  // 3. Agent server — bundle into single file
  await build({
    entryPoints: [path.join(root, 'scripts/agent-server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(root, 'dist-electron/agent-server.cjs'),
    external: [],
  })

  console.log('Electron build complete -> dist-electron/')
}

buildElectron().catch((err) => {
  console.error(err)
  process.exit(1)
})
