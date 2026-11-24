import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'

export type Fake = {
  wss: WebSocketServer
  url: string
  conns: WebSocket[]
  headers: IncomingMessage['headers'][]
  urls: string[]
  received: any[]
  onConn: (fn: (ws: WebSocket) => void) => void
  close: () => Promise<void>
}

export async function fakeServer(): Promise<Fake> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  const f: Fake = {
    wss, conns: [], headers: [], urls: [], received: [],
    url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    onConn: () => {},
    close: async () => { for (const c of wss.clients) c.terminate(); await new Promise<void>((r) => wss.close(() => r())) },
  }
  let hook: (ws: WebSocket) => void = () => {}
  f.onConn = (fn) => { hook = fn }
  wss.on('connection', (ws, req) => {
    f.conns.push(ws); f.headers.push(req.headers); f.urls.push(req.url ?? '')
    ws.on('message', (d) => f.received.push(JSON.parse(d.toString())))
    hook(ws)
  })
  return f
}

/** Real-I/O wait that works while vi fake timers are installed (setImmediate is not faked). */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = performance.now()
  while (!cond()) {
    if (performance.now() - start > ms) throw new Error('until: timed out')
    await new Promise((r) => setImmediate(r))
  }
}

export async function settle(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}
