import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { createChannel, channelRelay, NOT_CONNECTED_NOTICE, REPLACED_NOTICE, REFUSED_NOTICE, type Channel } from '../src/channel.js'
import { Relay } from '../src/relay.js'
import { VERSION } from '../src/version.js'
import { fakeServer, until, settle, type Fake } from './helpers.js'

const ChannelNote = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
})
const PermNote = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
})

let fake: Fake
let client: Client
let channel: Channel | undefined
const notes: Array<z.infer<typeof ChannelNote>['params']> = []
const perms: Array<z.infer<typeof PermNote>['params']> = []

async function boot(relay: Relay | null, opts?: { announce?: boolean }) {
  client = new Client({ name: 'claude-code', version: '2.1.240' }, { capabilities: {} })
  client.setNotificationHandler(ChannelNote, async (n) => { notes.push(n.params) })
  client.setNotificationHandler(PermNote, async (n) => { perms.push(n.params) })
  channel = createChannel(relay, opts)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await channel.server.connect(b)
  await client.connect(a)
}

beforeEach(async () => { fake = await fakeServer(); notes.length = 0; perms.length = 0 })
afterEach(async () => {
  channel?.relay?.stop(); channel = undefined
  await client?.close()
  await fake.close()
})

const mkRelay = () => new Relay({ server: fake.url, token: 't', agentName: 'A', pairingId: 'p' }, 'sess-9', '0.1.0', { jitter: () => 0 })

describe('channel server', () => {
  it('declares the channel + permission capabilities, tools, name and instructions', async () => {
    await boot(mkRelay())
    expect(client.getServerVersion()?.name).toBe('arkivist')
    expect(client.getServerVersion()?.version).toBe(VERSION) // one source: package.json via the build define
    const caps = client.getServerCapabilities()!
    expect(caps.tools).toEqual({})
    expect(caps.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })
    const ins = client.getInstructions()!
    expect(ins).toContain('<channel source="arkivist"')
    expect(ins).toContain('reply')
    expect(ins).toMatch(/owner/i)
  })

  it('lists a reply tool taking text', async () => {
    await boot(mkRelay())
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['reply'])
    expect((tools[0].inputSchema as any).required).toEqual(['text'])
  })

  it('sends hello with Claude Code version from the MCP client info after initialize', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    expect(fake.received[0]).toMatchObject({ type: 'hello', session_id: 'sess-9', plugin_version: '0.1.0', claude_code_version: '2.1.240' })
  })

  it('message frame => channel notification with meta.event_id, then ack', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    fake.conns[0].send(JSON.stringify({ type: 'message', event_id: '$e1', text: 'push it' }))
    await until(() => notes.length === 1)
    expect(notes[0]).toEqual({ content: 'push it', meta: { event_id: '$e1' } })
    await until(() => fake.received.some((f) => f.type === 'ack'))
    expect(fake.received.find((f) => f.type === 'ack')).toEqual({ type: 'ack', event_id: '$e1' })
  })

  it('delivers a duplicate event_id once but acks both', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    const m = JSON.stringify({ type: 'message', event_id: '$dup', text: 'once' })
    fake.conns[0].send(m); fake.conns[0].send(m)
    await until(() => fake.received.filter((f) => f.type === 'ack').length === 2)
    await settle()
    expect(notes.length).toBe(1)
  })

  it('dedupe memory is bounded', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    const ws = fake.conns[0]
    for (let i = 0; i < 502; i++) ws.send(JSON.stringify({ type: 'message', event_id: `$e${i}`, text: 'x' }))
    await until(() => notes.length === 502, 8000)
    ws.send(JSON.stringify({ type: 'message', event_id: '$e0', text: 'again' }))   // evicted: delivered again
    ws.send(JSON.stringify({ type: 'message', event_id: '$e501', text: 'again' })) // recent: dropped
    await until(() => notes.length === 503)
    await settle()
    expect(notes.length).toBe(503)
  })

  it('reply tool => reply frame', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    const res = await client.callTool({ name: 'reply', arguments: { text: 'done!' } })
    expect(res.isError).toBeFalsy()
    await until(() => fake.received.some((f) => f.type === 'reply'))
    expect(fake.received.find((f) => f.type === 'reply')).toEqual({ type: 'reply', text: 'done!' })
  })

  it('reply tool reports an error when the socket is down', async () => {
    const r = mkRelay()
    await boot(r)  // not connected yet at the instant we call: stop it first
    r.stop()
    await settle()
    const res = await client.callTool({ name: 'reply', arguments: { text: 'x' } })
    expect(res.isError).toBe(true)
  })

  it('permission_request => permission_request frame; verdict => permission notification', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run shell command', input_preview: '{"command":"git push"}' },
    } as any)
    await until(() => fake.received.some((f) => f.type === 'permission_request'))
    expect(fake.received.find((f) => f.type === 'permission_request')).toEqual({
      type: 'permission_request', request_id: 'abcde', tool_name: 'Bash',
      description: 'Run shell command', input_preview: '{"command":"git push"}',
    })
    fake.conns[0].send(JSON.stringify({ type: 'verdict', request_id: 'abcde', behavior: 'allow' }))
    await until(() => perms.length === 1)
    expect(perms[0]).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  it('ignores a verdict with an invalid behavior', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    fake.conns[0].send(JSON.stringify({ type: 'verdict', request_id: 'abcde', behavior: 'maybe' }))
    await settle()
    expect(perms.length).toBe(0)
  })

  it('surfaces a notice frame to Claude as a channel notification and keeps running', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    fake.conns[0].send(JSON.stringify({ type: 'notice', notice: 'Update the plugin: claude plugin marketplace update arkivist && claude plugin update arkivist@arkivist' }))
    await until(() => notes.length === 1)
    expect(notes[0].content).toBe('Update the plugin: claude plugin marketplace update arkivist && claude plugin update arkivist@arkivist')
    expect(notes[0].meta).toEqual({ kind: 'notice' })
  })

  it('revoked / replaced => its own notice, no reconnect', async () => {
    const r = mkRelay()
    await boot(r)
    await until(() => fake.received.length > 0)
    fake.conns[0].send(JSON.stringify({ type: 'revoked' }))
    await until(() => notes.length === 1)
    expect(notes[0].content).toBe(NOT_CONNECTED_NOTICE)
    expect(NOT_CONNECTED_NOTICE).toBe('This Claude Code is not connected to Arkivist. Run /arkivist:pair or npx @arkivist/claude connect.')
    expect(r.stopped).toBe(true)
  })

  it('replaced => not-connected notice', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    fake.conns[0].send(JSON.stringify({ type: 'replaced' }))
    await until(() => notes.length === 1)
    expect(notes[0].content).toBe(REPLACED_NOTICE)
  })

  it('refused => one-time refused notice', async () => {
    const r = mkRelay()
    await boot(r)
    r.emit('refused')
    await until(() => notes.length === 1)
    expect(notes[0].content).toBe(REFUSED_NOTICE)
  })

  it('no config => not-connected notice and a reply tool that errors', async () => {
    await boot(null)
    await until(() => notes.length === 1)
    expect(notes[0].content).toBe(NOT_CONNECTED_NOTICE)
    const res = await client.callTool({ name: 'reply', arguments: { text: 'x' } })
    expect(res.isError).toBe(true)
  })
})

// Every Claude Code session on the computer loads the plugin (it is a user
// install), but only the one started by arkivist-claude-start may hold the
// connection: the launcher sets ARKIVIST_CHANNEL=1. Any other session must
// neither connect (it would take the pairing over and silently drop the
// owner's messages) nor announce anything.
describe('only a launcher-started session connects', () => {
  const cfg = { server: 'https://x.example', token: 't', agentName: 'A', pairingId: 'p' }

  it('connects only with ARKIVIST_CHANNEL=1', () => {
    const read = vi.fn(() => cfg)
    expect(channelRelay({}, read, '0.2.1')).toBeNull()
    expect(channelRelay({ ARKIVIST_CHANNEL: '0' }, read, '0.2.1')).toBeNull()
    expect(read).not.toHaveBeenCalled()
    const r = channelRelay({ ARKIVIST_CHANNEL: '1' }, read, '0.2.1')
    expect(r).toBeInstanceOf(Relay)
    r?.stop()
  })

  it('launcher-started but not paired: no relay', () => {
    expect(channelRelay({ ARKIVIST_CHANNEL: '1' }, () => null, '0.2.1')).toBeNull()
  })

  it('a session not started by the launcher stays silent (no not-connected notice)', async () => {
    await boot(null, { announce: false })
    await settle()
    expect(notes).toEqual([])
  })
})

describe('reply splitting and limits', () => {
  const replies = () => fake.received.filter((f) => f.type === 'reply')
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

  it('splits a 100 kB multibyte reply into frames of at most 30000 bytes that concatenate to the input', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    const text = ('héllo wörld \u{1F600} 日本語 line\n').repeat(4000) // ~100+ kB
    expect(bytes(text)).toBeGreaterThan(100_000)
    const res = await client.callTool({ name: 'reply', arguments: { text } })
    expect(res.isError).toBeFalsy()
    await until(() => replies().map((f) => f.text).join('').length >= text.length)
    const parts = replies().map((f) => f.text as string)
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts) { expect(bytes(p)).toBeLessThanOrEqual(30_000); expect(p).not.toContain('�') }
    expect(parts.join('')).toBe(text)
  })

  it('refuses a reply over 512 KiB with isError and sends nothing', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    const res = await client.callTool({ name: 'reply', arguments: { text: 'a'.repeat(600 * 1024) } })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/512 KiB/)
    await settle()
    expect(replies().length).toBe(0)
  })

  it('isError when the socket is closed, not "sent"', async () => {
    await boot(mkRelay())
    await until(() => fake.received.length > 0)
    fake.conns[0].terminate()
    await until(() => !channel!.relay!.isOpen())
    channel!.relay!.stop()
    const res = await client.callTool({ name: 'reply', arguments: { text: 'hi' } })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/not connected/i)
  })

  it('a drop part-way through a multi-chunk reply says the first part WAS delivered', async () => {
    const relay = mkRelay()
    await boot(relay)
    await until(() => fake.received.length > 0)
    const real = relay.send.bind(relay)
    let n = 0
    vi.spyOn(relay, 'send').mockImplementation((f) => (++n >= 2 ? false : real(f)))
    const text = ('line of text\n').repeat(6000) // > 30,000 bytes: several chunks
    const res = await client.callTool({ name: 'reply', arguments: { text } })
    expect(res.isError).toBe(true)
    const msg = JSON.stringify(res.content)
    expect(msg).toMatch(/first part of your reply was delivered/)
    expect(msg).toMatch(/Send only the rest/)
    expect(msg).not.toMatch(/Send it again/)
  })
})
