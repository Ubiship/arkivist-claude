import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, launcherScript, type Deps } from '../src/cli.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'

let home: string
let calls: Array<{ cmd: string; args: string[] }>
let out: string[]
let errs: string[]
let listOutput: string
let listCalls: Array<{ cmd: string; args: string[] }>
let spawnStatus: (cmd: string, args: string[]) => number
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME }

const OK = { token: 'tok-123', agent_name: 'Atlas', pairing_id: 'pair-1' }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>
function deps(over: Partial<Deps> = {}): Deps {
  return {
    spawn: (cmd, args) => { calls.push({ cmd, args }); return { status: spawnStatus(cmd, args) } },
    capture: (cmd, args) => { listCalls.push({ cmd, args }); return { status: 0, stdout: listOutput } },
    fetch: fetchMock as unknown as typeof fetch,
    hostname: () => 'maxs-mac',
    home,
    env: { PATH: '/usr/bin' },
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    ...over,
  }
}
const cfgFile = () => join(home, 'xdg', 'arkivist', 'agent.json')
const launcher = () => join(home, '.local', 'bin', 'arkivist-claude-start')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'arkivist-cli-'))
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, 'xdg')
  calls = []; out = []; errs = []
  spawnStatus = () => 0
  listOutput = '[]'; listCalls = []
  fetchMock = vi.fn(async () => json(200, OK))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME
  if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG
})

describe('connect', () => {
  it('redeems, writes config, runs the two plugin commands in order, writes the launcher', async () => {
    const code = await main(['connect', 'ABCD-1234', '--server', 'https://ubicomm.example.net/'], deps())
    expect(code).toBe(0)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ubicomm.example.net/portal/claude-agent/redeem')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ code: 'ABCD-1234', machine_label: 'maxs-mac' })
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toEqual({
      server: 'https://ubicomm.example.net', token: 'tok-123', agentName: 'Atlas', pairingId: 'pair-1',
    })
    expect(calls).toEqual([
      { cmd: 'claude', args: ['plugin', 'marketplace', 'add', 'Ubiship/arkivist-claude'] },
      { cmd: 'claude', args: ['plugin', 'install', 'arkivist@arkivist'] },
    ])
    // The launcher's behaviour is pinned by running it (describe 'launcher script' below).
    expect(readFileSync(launcher(), 'utf8')).toBe(launcherScript())
    expect(statSync(launcher()).mode & 0o777).toBe(0o755)
    expect(out.join('\n')).toContain('arkivist-claude-start')
    expect(JSON.stringify([out, errs])).not.toContain('tok-123')
  })

  it('--marketplace overrides the repo with a local path', async () => {
    await main(['connect', 'C', '--server', 'https://s.example', '--marketplace', '/work/arkivist-claude'], deps())
    expect(calls[0].args).toEqual(['plugin', 'marketplace', 'add', '/work/arkivist-claude'])
  })

  it('prints a PATH hint only when ~/.local/bin is not on PATH', async () => {
    await main(['connect', 'C', '--server', 'https://s.example'], deps())
    expect(out.join('\n')).toMatch(/PATH/)
    out.length = 0
    await main(['connect', 'C', '--server', 'https://s.example'], deps({ env: { PATH: `/usr/bin:${join(home, '.local', 'bin')}` } }))
    expect(out.join('\n')).not.toMatch(/not on your PATH/)
  })

  it('a failed redeem prints the server message verbatim, exits 1, touches nothing', async () => {
    const msg = "That code didn't work. Get a new code and try again."
    fetchMock.mockResolvedValue(json(400, { error: msg }))
    const code = await main(['connect', 'BAD', '--server', 'https://s.example'], deps())
    expect(code).toBe(1)
    expect(errs.join('\n')).toContain(msg)
    expect(existsSync(cfgFile())).toBe(false)
    expect(existsSync(launcher())).toBe(false)
    expect(calls).toEqual([])
  })

  it('a 429 says too many attempts', async () => {
    fetchMock.mockResolvedValue(json(429, { error: 'rate limit exceeded' }))
    const code = await main(['connect', 'X', '--server', 'https://s.example'], deps())
    expect(code).toBe(1)
    expect(errs.join('\n')).toMatch(/too many attempts.*wait and try again/i)
    expect(existsSync(cfgFile())).toBe(false)
    expect(calls).toEqual([])
  })

  it('a network failure exits 1 without touching anything', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await main(['connect', 'X', '--server', 'https://s.example'], deps())).toBe(1)
    expect(errs.join('\n')).toMatch(/could not reach/i)
    expect(existsSync(cfgFile())).toBe(false)
  })

  it('refuses a malformed 200 body', async () => {
    fetchMock.mockResolvedValue(json(200, { token: 'x' }))
    expect(await main(['connect', 'X', '--server', 'https://s.example'], deps())).toBe(1)
    expect(existsSync(cfgFile())).toBe(false)
  })

  it('refuses cleartext http to a non-local server before any request', async () => {
    expect(await main(['connect', 'X', '--server', 'http://ubicomm.example.net'], deps())).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await main(['connect', 'X', '--server', 'http://localhost:8088'], deps())).toBe(0)
  })

  it('needs a code and --server', async () => {
    expect(await main(['connect', '--server', 'https://s.example'], deps())).toBe(1)
    expect(await main(['connect', 'C'], deps())).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failing marketplace add continues only if the SAME-source arkivist marketplace is registered', async () => {
    spawnStatus = (_c, a) => (a[1] === 'marketplace' ? 1 : 0)
    listOutput = JSON.stringify([{ name: 'arkivist', source: 'github', repo: 'Ubiship/arkivist-claude' }])
    expect(await main(['connect', 'C', '--server', 'https://s.example'], deps())).toBe(0)
    expect(calls.length).toBe(2)
    expect(listCalls[0].args).toEqual(['plugin', 'marketplace', 'list', '--json'])
  })

  it('a failing marketplace add with a DIFFERENT arkivist marketplace registered exits 1, no install', async () => {
    spawnStatus = (_c, a) => (a[1] === 'marketplace' ? 1 : 0)
    listOutput = JSON.stringify([{ name: 'arkivist', source: 'github', repo: 'someone/else' }])
    expect(await main(['connect', 'C', '--server', 'https://s.example', '--marketplace', '/typo/path'], deps())).toBe(1)
    expect(calls.map((c) => c.args[1])).toEqual(['marketplace'])
    expect(errs.join('\n')).toMatch(/marketplace add \/typo\/path/)
    // pairing is kept
    expect(existsSync(cfgFile())).toBe(true)
  })

  it('a failing marketplace add with nothing registered (or unparseable list) exits 1', async () => {
    spawnStatus = (_c, a) => (a[1] === 'marketplace' ? 1 : 0)
    expect(await main(['connect', 'C', '--server', 'https://s.example'], deps())).toBe(1)
    listOutput = 'not json'
    expect(await main(['connect', 'C', '--server', 'https://s.example'], deps())).toBe(1)
  })

  it('a failing install exits 1 and prints the exact two retry commands', async () => {
    spawnStatus = (_c, a) => (a[1] === 'install' ? 1 : 0)
    expect(await main(['connect', 'C', '--server', 'https://s.example'], deps())).toBe(1)
    const e = errs.join('\n')
    expect(e).toContain('claude plugin marketplace add Ubiship/arkivist-claude')
    expect(e).toContain('claude plugin install arkivist@arkivist')
    expect(e).toMatch(/pairing is saved/)
    expect(existsSync(launcher())).toBe(false)
  })

  it('rejects a flag with a missing value or a value that is another flag', async () => {
    expect(await main(['connect', 'C', '--server', 'https://s.example', '--marketplace'], deps())).toBe(1)
    expect(await main(['connect', 'C', '--server', '--marketplace', 'x'], deps())).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('launch', () => {
  it('runs claude with the dev-channel flag and passes args through', async () => {
    spawnStatus = () => 7
    const code = await main(['launch', '--resume', 'x'], deps())
    expect(code).toBe(7)
    expect(calls).toEqual([{ cmd: 'claude', args: ['--dangerously-load-development-channels', 'plugin:arkivist@arkivist', '--resume', 'x'] }])
  })
})

describe('launcher command', () => {
  it('rewrites the launcher with no code and no network (an already-paired Mac picks up a new launcher)', async () => {
    expect(await main(['launcher'], deps())).toBe(0)
    expect(readFileSync(launcher(), 'utf8')).toBe(launcherScript())
    expect(statSync(launcher()).mode & 0o777).toBe(0o755)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(out.join('\n')).toMatch(/--background/)
  })
})

// The launcher is run for real, against stand-in claude / tmux / caffeinate
// that record how they were called.
describe('launcher script', () => {
  let bin: string
  let log: string
  const stub = (name: string, body = '') => {
    const f = join(bin, name)
    writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}`)
    chmodSync(f, 0o755)
  }
  const run = (args: string[], path = `${bin}:/usr/bin:/bin`) => {
    const f = join(home, 'start.sh')
    writeFileSync(f, launcherScript())
    chmodSync(f, 0o755)
    const r = spawnSync(f, args, { cwd: home, encoding: 'utf8', env: { PATH: path, HOME: home } })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls }
  }
  beforeEach(() => {
    bin = join(home, 'stubbin'); mkdirSync(bin, { recursive: true })
    log = join(home, 'calls.log')
  })

  it('runs claude with the dev-channel flag in the foreground, passing args through', () => {
    stub('claude')
    const r = run(['--resume', 'x'])
    expect(r.status).toBe(0)
    expect(r.calls).toEqual(['claude --dangerously-load-development-channels plugin:arkivist@arkivist --resume x'])
  })

  it('--background starts it in a detached tmux session kept awake, in the current folder', () => {
    stub('claude'); stub('caffeinate')
    stub('tmux', 'case "$1" in has-session) exit 1;; esac\n')
    const r = run(['--background'])
    expect(r.status).toBe(0)
    expect(r.calls[0]).toBe('tmux has-session -t arkivist-claude')
    expect(r.calls[1]).toBe(`tmux new-session -d -s arkivist-claude -c ${realpathSync(home)} caffeinate -is claude --dangerously-load-development-channels plugin:arkivist@arkivist`)
    expect(r.stdout).toMatch(/tmux attach -t arkivist-claude/)
  })

  it('--background without caffeinate (not a Mac) still starts, just not kept awake', () => {
    stub('claude')
    stub('tmux', 'case "$1" in has-session) exit 1;; esac\n')
    const r = run(['--background'], `${bin}:/bin`) // /usr/bin holds the real caffeinate on a Mac
    expect(r.status).toBe(0)
    expect(r.calls[1]).toBe(`tmux new-session -d -s arkivist-claude -c ${realpathSync(home)} claude --dangerously-load-development-channels plugin:arkivist@arkivist`)
  })

  it('--background passes extra words through to claude', () => {
    stub('claude'); stub('caffeinate')
    stub('tmux', 'case "$1" in has-session) exit 1;; esac\n')
    const r = run(['--background', '--resume', 'x'])
    expect(r.calls[1]).toMatch(/claude --dangerously-load-development-channels plugin:arkivist@arkivist --resume x$/)
  })

  it('--background when one is already running starts nothing and says how to see it', () => {
    stub('claude'); stub('tmux')
    const r = run(['--background'])
    expect(r.status).toBe(0)
    expect(r.calls).toEqual(['tmux has-session -t arkivist-claude'])
    expect(r.stdout).toMatch(/already running/i)
  })

  it('--background without tmux says how to get it and starts nothing', () => {
    stub('claude')
    const r = run(['--background'], `${bin}`)
    expect(r.status).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.stderr).toMatch(/brew install tmux/)
  })
})

describe('usage', () => {
  it('unknown command prints usage and exits 1', async () => {
    expect(await main(['nope'], deps())).toBe(1)
    expect(errs.join('\n')).toMatch(/connect/)
  })
})
