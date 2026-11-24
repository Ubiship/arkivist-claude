#!/usr/bin/env node
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { writeConfig } from './config.js'

export const DEFAULT_MARKETPLACE = 'Ubiship/arkivist-claude'
const PLUGIN_ID = 'arkivist@arkivist'
const LAUNCHER_NAME = 'arkivist-claude-start'
const CHANNEL_ARGS = ['--dangerously-load-development-channels', `plugin:${PLUGIN_ID}`]

export type Deps = {
  spawn: (cmd: string, args: string[]) => { status: number | null }
  /** Runs a command and returns its stdout (for read-only queries). */
  capture: (cmd: string, args: string[]) => { status: number | null; stdout: string }
  fetch: typeof fetch
  hostname: () => string
  home: string
  env: NodeJS.ProcessEnv
  out: (s: string) => void
  err: (s: string) => void
}

export function defaultDeps(): Deps {
  return {
    spawn: (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }),
    capture: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return { status: r.status, stdout: r.stdout ?? '' }
    },
    fetch: globalThis.fetch,
    hostname: osHostname,
    home: process.env.HOME || homedir(),
    env: process.env,
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
  }
}

const USAGE = `Usage:
  arkivist-claude connect <code> --server <url> [--marketplace <repo-or-path>]
  arkivist-claude launch [claude args...]
  arkivist-claude launcher        (re)write the ${LAUNCHER_NAME} launcher`

export const TMUX_SESSION = 'arkivist-claude'

/** The launcher written to ~/.local/bin. Plain sh, so it runs without Node on
 *  the PATH. Foreground by default. \`--background\` starts Claude Code in a
 *  detached tmux session in the current folder, kept awake with caffeinate
 *  where there is one (macOS), so closing the terminal window does not take
 *  the Claude Code offline. A second --background while one runs starts
 *  nothing. Extra arguments in background mode are passed as words (no
 *  spaces inside one). */
export function launcherScript(): string {
  const args = CHANNEL_ARGS.join(' ')
  return `#!/bin/sh
# Written by arkivist-claude. Starts Claude Code connected to Arkivist.
#   ${LAUNCHER_NAME}                 in this terminal
#   ${LAUNCHER_NAME} --background    keeps running after you close the terminal
if [ "$1" = "--background" ]; then
  shift
  if ! command -v tmux >/dev/null 2>&1; then
    echo "--background needs tmux. On a Mac: brew install tmux" >&2
    exit 1
  fi
  if tmux has-session -t ${TMUX_SESSION} 2>/dev/null; then
    echo "Already running in the background. To see it: tmux attach -t ${TMUX_SESSION}"
    exit 0
  fi
  awake=""
  command -v caffeinate >/dev/null 2>&1 && awake="caffeinate -is "
  cmd="\${awake}claude ${args}"
  [ $# -gt 0 ] && cmd="$cmd $*"
  tmux new-session -d -s ${TMUX_SESSION} -c "$PWD" "$cmd"
  echo "Claude Code is running in the background in $PWD and stays connected after you close this window."
  echo "To see it (the first time, to confirm the development-channel screen): tmux attach -t ${TMUX_SESSION}"
  echo "To leave it running again: press Ctrl-b, then d."
  exit 0
fi
exec claude ${args} "$@"
`
}

function writeLauncher(d: Deps): string {
  const binDir = join(d.home, '.local', 'bin')
  const file = join(binDir, LAUNCHER_NAME)
  mkdirSync(binDir, { recursive: true })
  writeFileSync(file, launcherScript())
  chmodSync(file, 0o755)
  return file
}

/** undefined when absent; throws when present without a usable value (missing, or another flag). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (!v || v.startsWith('-')) throw new Error(`${name} needs a value`)
  return v
}

/** True when `claude plugin marketplace list` already has an `arkivist` marketplace from this same source. */
function arkivistMarketplaceFrom(d: Deps, source: string): boolean {
  const r = d.capture('claude', ['plugin', 'marketplace', 'list', '--json'])
  if (r.status !== 0) return false
  try {
    const list = JSON.parse(r.stdout) as Array<Record<string, unknown>>
    return list.some((m) => m.name === 'arkivist' && [m.repo, m.url, m.path].includes(source))
  } catch {
    return false
  }
}

/** https only, except for a local server (the token must not cross the network in cleartext). */
function normaliseServer(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  return u.origin
}

async function connect(args: string[], d: Deps): Promise<number> {
  const code = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
  let serverArg: string | undefined
  let marketplaceArg: string | undefined
  try {
    serverArg = flag(args, '--server')
    marketplaceArg = flag(args, '--marketplace')
  } catch (e) {
    d.err((e as Error).message)
    d.err(USAGE)
    return 1
  }
  if (!code || !serverArg) { d.err(USAGE); return 1 }
  const server = normaliseServer(serverArg)
  if (!server) {
    d.err('The server must be an https:// address (http:// is only allowed for localhost).')
    return 1
  }
  let marketplace = marketplaceArg ?? DEFAULT_MARKETPLACE
  if (marketplace.startsWith('.') || marketplace.startsWith('/')) marketplace = resolve(marketplace)

  let res: Response
  try {
    res = await d.fetch(`${server}/portal/claude-agent/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, machine_label: d.hostname() }),
    })
  } catch {
    d.err(`Could not reach ${server}. Check the address and your connection, then try again.`)
    return 1
  }
  let body: any = null
  try { body = await res.json() } catch { /* non-JSON body */ }
  if (res.status === 429) {
    d.err('Too many attempts. Wait and try again in a minute.')
    return 1
  }
  if (!res.ok) {
    d.err(typeof body?.error === 'string' && body.error ? body.error : `The server refused the code (HTTP ${res.status}).`)
    return 1
  }
  if (typeof body?.token !== 'string' || typeof body?.agent_name !== 'string' || typeof body?.pairing_id !== 'string' || !body.token) {
    d.err('The server sent an unexpected answer. Get a new code and try again.')
    return 1
  }
  writeConfig({ server, token: body.token, agentName: body.agent_name, pairingId: body.pairing_id })

  const retry = `claude plugin marketplace add ${marketplace}\n  claude plugin install ${PLUGIN_ID}`
  // `add` also fails when the marketplace is already registered; that is fine only if the
  // registered `arkivist` marketplace is from this same source (never silently install another).
  if (d.spawn('claude', ['plugin', 'marketplace', 'add', marketplace]).status !== 0) {
    if (!arkivistMarketplaceFrom(d, marketplace)) {
      d.err(`"claude plugin marketplace add ${marketplace}" failed (see above), and no "arkivist" marketplace from that source is registered. Your pairing is saved. Fix the address, then run:\n  ${retry}`)
      return 1
    }
  }
  if (d.spawn('claude', ['plugin', 'install', PLUGIN_ID]).status !== 0) {
    d.err(`"claude plugin install ${PLUGIN_ID}" failed (see above). Your pairing is saved; no new code is needed. Retry with:\n  ${retry}`)
    return 1
  }

  const file = writeLauncher(d)
  const binDir = join(d.home, '.local', 'bin')

  d.out(`Connected as "${body.agent_name}". Start Claude Code with:\n\n  ${LAUNCHER_NAME}\n\nor, to keep it connected after you close the terminal:\n\n  ${LAUNCHER_NAME} --background\n`)
  d.out('Claude Code will show a one-time confirmation screen for the development channel. Choose "I am using this for local development".')
  if (!(d.env.PATH ?? '').split(delimiter).includes(binDir)) {
    d.out(`\n${binDir} is not on your PATH. Add it (for example: export PATH="$HOME/.local/bin:$PATH") or run ${file} directly.`)
  }
  return 0
}

export async function main(argv: string[], d: Deps = defaultDeps()): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === 'connect') return connect(rest, d)
  if (cmd === 'launch') return d.spawn('claude', [...CHANNEL_ARGS, ...rest]).status ?? 1
  if (cmd === 'launcher') {
    const file = writeLauncher(d)
    d.out(`Wrote ${file}. Start Claude Code with ${LAUNCHER_NAME}, or ${LAUNCHER_NAME} --background to keep it connected after you close the terminal.`)
    return 0
  }
  d.err(USAGE)
  return 1
}

// realpath: npx runs this through a node_modules/.bin symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)))
}
