import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeServer, until, type Fake } from './helpers.js'

const root = join(import.meta.dirname, '..')
const committed = join(root, 'plugin', 'dist', 'server.js')
let bundle = '' // a TEMP build: tests never write to the working tree
let tmpBuild = ''

let fake: Fake
let xdg: string
let child: ChildProcessWithoutNullStreams | undefined

beforeAll(async () => {
  tmpBuild = mkdtempSync(join(tmpdir(), 'arkivist-build-'))
  bundle = join(tmpBuild, 'server.js')
  execFileSync('node', [join(root, 'scripts', 'build.mjs'), '--bundle-only', bundle], { cwd: root, stdio: 'pipe' })
  fake = await fakeServer()
  xdg = mkdtempSync(join(tmpdir(), 'arkivist-smoke-'))
  mkdirSync(join(xdg, 'arkivist'), { recursive: true })
  writeFileSync(join(xdg, 'arkivist', 'agent.json'),
    JSON.stringify({ server: fake.url, token: 'tok', agentName: 'Atlas', pairingId: 'p1' }))
}, 60_000)

afterAll(async () => {
  child?.kill()
  await fake?.close()
  rmSync(xdg, { recursive: true, force: true })
  rmSync(tmpBuild, { recursive: true, force: true })
})

describe('built plugin server over stdio', () => {
  it('plugin.json carries the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const plugin = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(plugin.version).toBe(pkg.version)
  })

  it('the committed bundle is up to date with src', () => {
    expect(existsSync(committed)).toBe(true)
    const fresh = readFileSync(bundle)
    if (!fresh.equals(readFileSync(committed))) throw new Error('plugin/dist/server.js is stale — run npm run build and commit it')
  })

  it('advertises claude/channel on initialize and says hello to the server', async () => {
    child = spawn('node', [bundle], {
      // not the repo, so no node_modules to lean on; started as the launcher starts it
      env: { PATH: process.env.PATH ?? '', HOME: xdg, XDG_CONFIG_HOME: xdg, ARKIVIST_CHANNEL: '1' },
      cwd: xdg,
    })
    let buf = ''
    child.stdout.on('data', (d) => { buf += d.toString() })
    const send = (m: object) => child!.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.240' },
    } })
    await until(() => buf.includes('"id":1'), 10_000)
    const res = JSON.parse(buf.split('\n').find((l) => l.includes('"id":1'))!)
    expect(res.result.capabilities.experimental['claude/channel']).toEqual({})
    expect(res.result.serverInfo.name).toBe('arkivist')
    // One version, from package.json: the MCP server info and hello agree.
    const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    expect(res.result.serverInfo.version).toBe(pkgVersion)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await until(() => fake.received.length > 0, 10_000)
    const hello = fake.received[0]
    expect(hello.type).toBe('hello')
    expect(hello.plugin_version).toBe(pkgVersion)
    expect(hello.claude_code_version).toBe('2.1.240')
    expect(fake.headers[0].authorization).toBe('Bearer tok')
  }, 30_000)

  const res = (b: string) => JSON.parse(b.split('\n').find((l) => l.includes('"id":1'))!)
  // The plugin is a user install, so every Claude Code session starts it.
  // One not started by the launcher must never take the pairing over.
  it('a session not started by the launcher answers MCP but never connects', async () => {
    child?.kill() // the launcher-started one above
    const before = fake.headers.length // the fake server is shared with the test above
    child = spawn('node', [bundle], {
      env: { PATH: process.env.PATH ?? '', HOME: xdg, XDG_CONFIG_HOME: xdg },
      cwd: xdg,
    })
    let buf = ''
    child.stdout.on('data', (d) => { buf += d.toString() })
    const send = (m: object) => child!.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.240' },
    } })
    await until(() => buf.includes('"id":1'), 10_000)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await new Promise((r) => setTimeout(r, 1500))
    expect(fake.headers.length - before, 'it connected to the server').toBe(0)
    expect(res(buf).result.serverInfo.name).toBe('arkivist')
    expect(buf, 'it announced itself in an unrelated session').not.toContain('notifications/claude/channel')
  }, 30_000)
})
