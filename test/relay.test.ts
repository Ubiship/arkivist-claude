import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Relay } from '../src/relay.js'
import { fakeServer, until, settle, type Fake } from './helpers.js'

let fake: Fake
let relay: Relay | undefined
const mk = (extra: Partial<{ server: string }> = {}) =>
  new Relay({ server: fake.url, token: 'tok-1', agentName: 'A', pairingId: 'p', ...extra }, 'sess-123', '0.1.0', { jitter: () => 0 })

beforeEach(async () => { fake = await fakeServer() })
afterEach(async () => {
  vi.useRealTimers()
  relay?.stop(); relay = undefined
  await fake.close()
})

describe('Relay connect', () => {
  it('connects to /portal/claude-agent/ws over ws with a Bearer header and sends hello first', async () => {
    relay = mk(); relay.claudeCodeVersion = '2.1.240'; relay.start()
    await until(() => fake.received.length > 0)
    expect(fake.urls[0]).toBe('/portal/claude-agent/ws')
    expect(fake.headers[0].authorization).toBe('Bearer tok-1')
    expect(fake.received[0]).toEqual({ type: 'hello', session_id: 'sess-123', plugin_version: '0.1.0', claude_code_version: '2.1.240' })
  })

  it('omits claude_code_version when unknown', async () => {
    relay = mk(); relay.start()
    await until(() => fake.received.length > 0)
    expect('claude_code_version' in fake.received[0]).toBe(false)
  })

  it('maps https to wss and http to ws', () => {
    expect(Relay.wsUrl('https://a.example/')).toBe('wss://a.example/portal/claude-agent/ws')
    expect(Relay.wsUrl('http://localhost:9090')).toBe('ws://localhost:9090/portal/claude-agent/ws')
  })

  it('emits message, verdict and notice frames; send() writes frames', async () => {
    relay = mk()
    const got: any[] = []
    relay.on('message', (f) => got.push(['message', f.event_id]))
    relay.on('verdict', (f) => got.push(['verdict', f.request_id, f.behavior]))
    relay.on('notice', (t) => got.push(['notice', t]))
    relay.start()
    await until(() => fake.conns.length === 1)
    const ws = fake.conns[0]
    ws.send(JSON.stringify({ type: 'message', event_id: '$e1', text: 'hi' }))
    ws.send(JSON.stringify({ type: 'verdict', request_id: 'abcde', behavior: 'allow' }))
    ws.send(JSON.stringify({ type: 'notice', notice: 'hello there' }))
    await until(() => got.length === 3)
    expect(got).toEqual([['message', '$e1'], ['verdict', 'abcde', 'allow'], ['notice', 'hello there']])
    expect(relay.send({ type: 'ack', event_id: '$e1' })).toBe(true)
    await until(() => fake.received.some((f) => f.type === 'ack'))
  })

  it('send() returns false when not connected', () => {
    relay = mk()
    expect(relay.send({ type: 'ack', event_id: 'x' })).toBe(false)
  })

  it('ignores garbage frames without dying', async () => {
    relay = mk(); relay.start()
    await until(() => fake.conns.length === 1)
    fake.conns[0].send('not json')
    const ids: string[] = []
    relay.on("message", (f) => ids.push(f.event_id))
    fake.conns[0].send(JSON.stringify({ type: "message", event_id: "$ok", text: "x" }))
    await settle()
    await until(() => ids.length === 1)
    expect(relay.isOpen()).toBe(true)
  })
})

describe('Relay reconnect', () => {
  it('backs off 1s, 2s, 4s... capped at 30s, after a bare close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fake.onConn((ws) => ws.close())
    relay = mk(); relay.start()
    await until(() => fake.conns.length === 1)
    const delays: number[] = []
    for (const d of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const n = fake.conns.length
      await settle()
      await vi.advanceTimersByTimeAsync(d - 1)
      await settle()
      expect(fake.conns.length, `before ${d}ms`).toBe(n)
      await vi.advanceTimersByTimeAsync(1)
      await until(() => fake.conns.length === n + 1)
      delays.push(d)
    }
    expect(delays.length).toBe(7)
  })

  it('adds jitter on top of the backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fake.onConn((ws) => ws.close())
    relay = new Relay({ server: fake.url, token: 't', agentName: 'A', pairingId: 'p' }, 's', '0.1.0', { jitter: () => 500 })
    relay.start()
    await until(() => fake.conns.length === 1)
    await settle()
    await vi.advanceTimersByTimeAsync(1499)
    await settle()
    expect(fake.conns.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => fake.conns.length === 2)
  })

  it('resets the backoff after a connection that stayed up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let n = 0
    fake.onConn((ws) => { n++; if (n === 2) setTimeout(() => ws.close(), 20000); else ws.close() })
    relay = mk(); relay.start()
    await until(() => fake.conns.length === 1)
    await settle(); await vi.advanceTimersByTimeAsync(1000)
    await until(() => fake.conns.length === 2)
    await settle(); await vi.advanceTimersByTimeAsync(20000)   // conn 2 lives 20s, then closes
    await settle()
    await vi.advanceTimersByTimeAsync(1000)                    // back to a 1s delay
    await until(() => fake.conns.length === 3)
  })

  it('does not reconnect after revoked (60s of fake time) and emits revoked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    relay = mk()
    const seen: string[] = []
    relay.on('revoked', () => seen.push('revoked'))
    relay.start()
    await until(() => fake.conns.length === 1)
    fake.conns[0].send(JSON.stringify({ type: 'revoked' }))
    fake.conns[0].close()
    await until(() => seen.length === 1)
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(fake.conns.length).toBe(1)
    expect(relay.stopped).toBe(true)
  })

  it('does not reconnect after replaced and emits replaced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    relay = mk()
    const seen: string[] = []
    relay.on('replaced', () => seen.push('replaced'))
    relay.start()
    await until(() => fake.conns.length === 1)
    fake.conns[0].send(JSON.stringify({ type: 'replaced' }))
    fake.conns[0].close()
    await until(() => seen.length === 1)
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(fake.conns.length).toBe(1)
  })

  it('treats a close right after a notice as terminal (outdated plugin)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    relay = mk()
    const notes: string[] = []
    relay.on('notice', (t) => notes.push(t))
    const terminal: string[] = []
    relay.on('terminal', (why) => terminal.push(why))
    relay.start()
    await until(() => fake.conns.length === 1)
    fake.conns[0].send(JSON.stringify({ type: 'notice', notice: 'Update the plugin: claude plugin marketplace update arkivist && claude plugin update arkivist@arkivist' }))
    fake.conns[0].close()
    await until(() => terminal.length === 1)
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(fake.conns.length).toBe(1)
    expect(notes).toEqual(['Update the plugin: claude plugin marketplace update arkivist && claude plugin update arkivist@arkivist'])
    expect(terminal).toEqual(['notice-then-close'])
  })

  it('a close right after any OTHER notice is an ordinary drop: it reconnects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    relay = mk()
    const terminal: string[] = []
    relay.on('terminal', (why) => terminal.push(why))
    relay.start()
    await until(() => fake.conns.length === 1)
    fake.conns[0].send(JSON.stringify({ type: 'notice', notice: "Your last reply didn't fully reach the chat. Try sending it again." }))
    await settle()
    fake.conns[0].close() // a network drop straight after
    await until(() => !relay!.isOpen())
    await settle()
    await vi.advanceTimersByTimeAsync(1_100)
    await until(() => fake.conns.length === 2)
    expect(terminal).toEqual([])
    expect(relay.stopped).toBe(false)
  })

  it('a notice alone does not stop the relay', async () => {
    relay = mk(); relay.start()
    await until(() => fake.conns.length === 1)
    fake.conns[0].send(JSON.stringify({ type: 'notice', notice: 'Your last reply...' }))
    await settle()
    expect(relay.isOpen()).toBe(true)
    expect(relay.stopped).toBe(false)
  })

  it('stop() prevents any further connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fake.onConn((ws) => ws.close())
    relay = mk(); relay.start()
    await until(() => fake.conns.length === 1)
    relay.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(fake.conns.length).toBe(1)
  })
})

describe('Relay refused upgrades', () => {
  it('emits refused once after 5 consecutive 401s and keeps retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fake.wss.close()
    const http = await import('node:http')
    const srv = http.createServer((_q, res) => { hits++; res.statusCode = 401; res.end() })
    let hits = 0
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as any).port
    relay = new Relay({ server: `http://127.0.0.1:${port}`, token: 't', agentName: 'A', pairingId: 'p' }, 's', '0.1.0', { jitter: () => 0 })
    let refused = 0
    relay.on('refused', () => refused++)
    relay.start()
    for (let i = 0; i < 7; i++) {
      await until(() => hits === i + 1)
      await settle()
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(refused).toBe(1)
    expect(hits).toBeGreaterThanOrEqual(7)
    relay.stop()
    srv.close()
  })
})
