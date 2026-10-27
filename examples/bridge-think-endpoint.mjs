#!/usr/bin/env node
/**
 * 参考实现：dsh-heartbeat 的 HTTP 思考接口
 *
 * 插件会 POST /think 发来一段 prompt，这里负责把它交给一个常驻的
 * `dsh --profile sdk` 子进程，拿到最终回答再返回。
 *
 *   node bridge-think-endpoint.mjs            # 默认 127.0.0.1:3002
 *   THINK_PORT=3010 node bridge-think-endpoint.mjs
 *
 * 它刻意只做一件事：一个进程、一个 SDK 连接、一个 HTTP 路由。
 * 真实项目里通常会把它和 OneBot 客户端放在同一个进程（见 napcat-bridge）。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { createInterface } from 'node:readline'

const PORT = Number(process.env.THINK_PORT || 3002)
const DSH_BIN = process.env.DSH_BIN || 'dsh'
const PROFILE = process.env.DSH_PROFILE || 'sdk'
const CWD = process.env.THINK_CWD || process.cwd()
const PROVIDER = process.env.DSH_PROVIDER || 'deepseek-official'
const MODEL = process.env.DSH_MODEL || 'deepseek-flash'
const SESSION_ID = process.env.THINK_SESSION || 'session-think'

/** 极简的 SDK 客户端：一次握手，多次提问。 */
class Sdk {
  constructor() {
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.turns = new Map()
    this.startPromise = null
  }

  async start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      this.proc = spawn(DSH_BIN, ['--profile', PROFILE], {
        cwd: CWD,
        env: { ...process.env, DSH_NO_HEARTBEAT: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const rl = createInterface({ input: this.proc.stdout })
      rl.on('line', (line) => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        if (msg.id !== undefined && !msg.method) {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result)
          return
        }
        if (msg.method === 'session.event') {
          const { sessionId, event } = msg.params || {}
          const turn = this.turns.get(sessionId)
          if (!turn) return
          if (event?.type === 'assistant/message') {
            const content = event.data?.message?.content || []
            turn.buffer += content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('')
          }
          return
        }
        if (msg.method === 'session.status') {
          const { sessionId, status } = msg.params || {}
          const turn = this.turns.get(sessionId)
          if (!turn) return
          if (status === 'running') turn.sawRunning = true
          if (status === 'idle' && turn.sawRunning && !turn.done) {
            turn.done = true
            this.turns.delete(sessionId)
            turn.resolve(turn.buffer.trim())
          }
        }
      })
      this.proc.stderr.on('data', (b) => {
        if (process.env.DSH_HEARTBEAT_DEBUG === '1') process.stderr.write(b)
      })
      this.proc.on('exit', () => { this.startPromise = null })
      await this.request('initialize', { cwd: CWD, provider: PROVIDER, model: MODEL })
    })()
    return this.startPromise
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`请求超时: ${method}`))
        }
      }, 180000)
    })
  }

  async ask(prompt) {
    await this.start()
    return new Promise((resolve, reject) => {
      const turn = { buffer: '', sawRunning: false, done: false, resolve, reject }
      this.turns.set(SESSION_ID, turn)
      this.request('session/prompt', {
        sessionId: SESSION_ID,
        contentBlocks: [{ type: 'text', text: prompt }],
      }).catch((error) => {
        this.turns.delete(SESSION_ID)
        reject(error)
      })
    })
  }
}

const sdk = new Sdk()

http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (req.url !== '/think' || req.method !== 'POST') return send(404, { error: 'not found' })

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    try {
      const { prompt } = JSON.parse(body || '{}')
      if (!prompt) return send(400, { error: 'prompt required' })
      send(200, { ok: true, text: await sdk.ask(prompt) })
    } catch (error) {
      send(500, { ok: false, error: String(error?.message || error) })
    }
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`think endpoint: http://127.0.0.1:${PORT}/think (profile=${PROFILE})`)
})
