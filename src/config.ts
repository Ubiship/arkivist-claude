import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CONNECT_COMMAND } from './install.js'

export type AgentConfig = { server: string; token: string; agentName: string; pairingId: string }

/** $XDG_CONFIG_HOME/arkivist/agent.json, else ~/.config/arkivist/agent.json. */
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config')
  return join(base, 'arkivist', 'agent.json')
}

/** null when the file does not exist; throws a clear error when it is unusable. The error never echoes file contents (the token is in there). */
export function readConfig(): AgentConfig | null {
  const p = configPath()
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw new Error(`Cannot read ${p}: ${e?.code ?? 'unknown error'}`)
  }
  let v: any
  try {
    v = JSON.parse(raw)
  } catch {
    throw new Error(`${p} is not valid JSON. Re-run: ${CONNECT_COMMAND}`)
  }
  for (const k of ['server', 'token', 'agentName', 'pairingId'] as const) {
    if (!v || typeof v[k] !== 'string' || !v[k]) {
      throw new Error(`${p} is missing "${k}". Re-run: ${CONNECT_COMMAND}`)
    }
  }
  return { server: v.server, token: v.token, agentName: v.agentName, pairingId: v.pairingId }
}

/** Writes the config with mode 0600 inside a 0700 directory. */
export function writeConfig(c: AgentConfig): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  chmodSync(dirname(p), 0o700)
  writeFileSync(p, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600) // writeFile's mode only applies on create
}
