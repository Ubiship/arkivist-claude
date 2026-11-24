// npm run build            tsc -> dist/ (the npm CLI), then esbuild -> plugin/dist/server.js
// node scripts/build.mjs --bundle-only <outfile>   just the esbuild step, to any path
// npm run check:bundle     bundle to a temp file, fail if it differs from the committed plugin/dist/server.js
//
// plugin/dist/server.js is ONE self-contained file because a marketplace install copies the
// plugin directory only: no node_modules, no npm run build.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const committed = `${root}plugin/dist/server.js`
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

async function bundle(outfile) {
  await build({
    entryPoints: [`${root}src/server.ts`],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['bufferutil', 'utf-8-validate'], // ws's optional native accelerators
    define: { __ARKIVIST_VERSION__: JSON.stringify(version) },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  })
}

const [mode, arg] = process.argv.slice(2)
if (mode === '--bundle-only') {
  await bundle(arg)
} else if (mode === '--check') {
  const dir = mkdtempSync(join(tmpdir(), 'arkivist-bundle-'))
  try {
    await bundle(join(dir, 'server.js'))
    if (!readFileSync(join(dir, 'server.js')).equals(readFileSync(committed))) {
      console.error('plugin/dist/server.js is stale — run npm run build and commit it')
      process.exit(1)
    }
    console.log('plugin/dist/server.js is up to date')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} else {
  rmSync(`${root}dist`, { recursive: true, force: true })
  rmSync(`${root}plugin/dist`, { recursive: true, force: true })
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
  await bundle(committed)
}
