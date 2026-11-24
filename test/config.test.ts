import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, readConfig, writeConfig, type AgentConfig } from '../src/config.js'

const cfg: AgentConfig = { server: 'https://x.example', token: 'tok-secret', agentName: "Max's Claude", pairingId: 'p1' }
let dir: string
const saved = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arkivist-cfg-'))
  process.env.XDG_CONFIG_HOME = dir
})
afterEach(() => {
  process.env = { ...saved }
  rmSync(dir, { recursive: true, force: true })
})

describe('config', () => {
  it('uses XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configPath()).toBe(join(dir, 'arkivist', 'agent.json'))
    delete process.env.XDG_CONFIG_HOME
    process.env.HOME = '/home/u'
    expect(configPath()).toBe('/home/u/.config/arkivist/agent.json')
  })

  it('returns null when missing', () => {
    expect(readConfig()).toBeNull()
  })

  it('writes 0600 in a 0700 dir and round-trips', () => {
    writeConfig(cfg)
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'arkivist')).mode & 0o777).toBe(0o700)
    expect(readConfig()).toEqual(cfg)
  })

  it('tightens an existing looser file to 0600', () => {
    mkdirSync(join(dir, 'arkivist'), { recursive: true })
    writeFileSync(configPath(), '{}', { mode: 0o644 })
    writeConfig(cfg)
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it('throws a clear error on malformed JSON, without the file contents', () => {
    mkdirSync(join(dir, 'arkivist'), { recursive: true })
    writeFileSync(configPath(), '{not json tok-secret')
    expect(() => readConfig()).toThrow(/agent\.json.*not valid JSON/i)
    try { readConfig() } catch (e) { expect(String(e)).not.toContain('tok-secret') }
  })

  it('throws when required fields are missing', () => {
    mkdirSync(join(dir, 'arkivist'), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ server: 'x' }))
    expect(() => readConfig()).toThrow(/token/)
  })
})
