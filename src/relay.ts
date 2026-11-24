import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { AgentConfig } from './config.js'

/** Wire frame; mirrors internal/claudeagent/frames.go. */
export type Frame = {
  type: string
  event_id?: string
  text?: string
  sent_at?: string
  request_id?: string
  behavior?: string
  tool_name?: string
  description?: string
  input_preview?: string
  session_id?: string
  plugin_version?: string
  claude_code_version?: string
  notice?: string
}

const PATH = '/portal/claude-agent/ws'
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 30_000
const JITTER_MAX_MS = 250
/** A connection that lasted this long counts as healthy and resets the backoff. */
const STABLE_MS = 10_000
/** A close within this long of the update-required notice is the server refusing us. */
const NOTICE_THEN_CLOSE_MS = 2_000
/** The server's min-version refusal (minClaudePluginVersion, handlers_claude_agent_ws.go):
 *  the only notice after which a close is terminal. Any other notice (a reply cut short)
 *  followed by a network drop is an ordinary drop and reconnects. */
export const UPDATE_REQUIRED_PREFIX = 'Update the plugin:'
/** This many 401s in a row on upgrade earns the user a one-time notice. */
const REFUSED_AFTER = 5

export type RelayOptions = { jitter?: () => number }

/**
 * One outbound WebSocket to UbiComm's relay.
 * Events: message(Frame), verdict(Frame), notice(string), revoked, replaced,
 * terminal(reason) — after which the relay never reconnects.
 */
export class Relay extends EventEmitter {
  claudeCodeVersion?: string
  stopped = false
  private ws?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private attempt = 0
  private openedAt = 0
  private updateNoticeAt = -Infinity
  private refusals = 0
  private refusedEmitted = false
  private readonly jitter: () => number

  constructor(
    private readonly cfg: AgentConfig,
    private readonly sessionId: string,
    private readonly version: string,
    opts: RelayOptions = {},
  ) {
    super()
    this.jitter = opts.jitter ?? (() => Math.random() * JITTER_MAX_MS)
  }

  static wsUrl(server: string): string {
    const u = new URL(server)
    const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}${PATH}`
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start(): void {
    if (this.stopped || this.ws) return
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      ws.removeAllListeners('message')
      ws.on('error', () => {})
      try { ws.close() } catch { /* already closing */ }
    }
  }

  send(frame: Frame): boolean {
    if (!this.isOpen()) return false
    try {
      this.ws!.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private connect(): void {
    this.timer = undefined
    const ws = new WebSocket(Relay.wsUrl(this.cfg.server), {
      headers: { Authorization: `Bearer ${this.cfg.token}` },
    })
    this.ws = ws
    // With a listener attached ws no longer fails the socket itself: end it so 'close' fires.
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      ws.terminate()
      if (res.statusCode === 401 && ++this.refusals >= REFUSED_AFTER && !this.refusedEmitted) {
        this.refusedEmitted = true
        this.emit('refused')
      }
    })
    ws.on('open', () => {
      this.refusals = 0
      this.openedAt = Date.now()
      const hello: Frame = { type: 'hello', session_id: this.sessionId, plugin_version: this.version }
      if (this.claudeCodeVersion) hello.claude_code_version = this.claudeCodeVersion
      ws.send(JSON.stringify(hello))
    })
    ws.on('message', (data) => this.onFrame(data.toString()))
    // Errors (refused connection, 401 on upgrade) are followed by 'close'; reconnect there.
    ws.on('error', () => {})
    ws.on('close', () => this.onClose(ws))
  }

  private onFrame(raw: string): void {
    let f: Frame
    try { f = JSON.parse(raw) } catch { return }
    if (!f || typeof f.type !== 'string') return
    switch (f.type) {
      case 'message': this.emit('message', f); break
      case 'verdict': this.emit('verdict', f); break
      case 'notice':
        if (f.notice?.startsWith(UPDATE_REQUIRED_PREFIX)) this.updateNoticeAt = Date.now()
        if (f.notice) this.emit('notice', f.notice)
        break
      case 'revoked':
        this.terminate('revoked'); this.emit('revoked'); break
      case 'replaced':
        this.terminate('replaced'); this.emit('replaced'); break
    }
  }

  private terminate(reason: string): void {
    if (this.stopped) return
    this.stop()
    this.emit('terminal', reason)
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return // an old socket, or stop() already ran
    this.ws = undefined
    if (this.stopped) return
    if (Date.now() - this.updateNoticeAt <= NOTICE_THEN_CLOSE_MS) {
      this.stopped = true
      this.emit('terminal', 'notice-then-close')
      return
    }
    if (this.openedAt && Date.now() - this.openedAt >= STABLE_MS) this.attempt = 0
    this.openedAt = 0
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.attempt) + this.jitter()
    this.attempt++
    this.timer = setTimeout(() => this.connect(), delay)
  }
}
