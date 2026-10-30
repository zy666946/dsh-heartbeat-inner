/**
 * dsh-heartbeat —— 主动心跳插件
 *
 * 定期醒来，让一个专属的「内心会话」自己决定：要不要主动给主人发条消息？
 *
 * 设计要点：
 *  - 不做机械复读：每次醒来都问模型「想不想发」，大多数时候答案是不发（这是特性）
 *  - 内心会话是持久会话：上次想过什么、发过什么，下次醒来还记得
 *  - 三重刹车：安静时段 / 两次发送最小间隔 / 主人刚说过话不打扰 / 每日上限
 *  - 思考引擎隔离在子进程里（dsh --profile sdk），用完即走，不占常驻内存
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'

export const name = 'heartbeat'

export const inject = []

const DEFAULTS = {
  enabled: true,
  sessionId: 'session-heartbeat-inner',
  intervalMinutes: 30,
  startDelaySeconds: 60,
  quietFrom: 0,
  quietTo: 7,
  minGapMinutes: 120,
  userActiveMinutes: 40,
  dailyMax: 5,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxTokens: 1024,
  cwd: '',
  timeZone: 'Asia/Shanghai',
  dshBin: 'dsh',
  profile: 'sdk',
  thinkUrl: '',
  qqStateUrl: 'http://127.0.0.1:3002/api/qq/state',
  channel: { kind: 'onebot', wsUrl: '', targetId: '' },
}

const THINK_TIMEOUT_MS = 180000

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function statePath() {
  return path.join(homeDir(), 'heartbeat', 'state.json')
}
function overridePath() {
  return path.join(homeDir(), 'heartbeat', 'config.json')
}
function loadOverrides() {
  try {
    return JSON.parse(readFileSync(overridePath(), 'utf8'))
  } catch {
    return {}
  }
}
function saveOverrides(values) {
  const current = loadOverrides()
  const next = { ...current, ...values }
  mkdirSync(path.dirname(overridePath()), { recursive: true })
  writeFileSync(overridePath(), JSON.stringify(next, null, 2))
  return next
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'))
  } catch {
    return { lastSentAt: 0, lastUserAt: 0, lastUserText: '', lastText: '', sentToday: 0, day: '' }
  }
}
function saveState(state) {
  try {
    mkdirSync(path.dirname(statePath()), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(state, null, 2))
  } catch {
    /* 状态写不进去不影响主流程 */
  }
}

function clockOf(timeZone) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, p) => (p.type === 'literal' ? acc : ((acc[p.type] = p.value), acc)), {})
  return {
    text: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
  }
}

function ago(ms) {
  if (!ms) return '还不知道'
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分前`
}

function buildPrompt(cfg, state, clock) {
  return [
    '【安静的内心时刻】',
    `现在：${clock.text}（${clock.weekday}）`,
    `距我上次主动给主人发消息：${state.lastSentAt ? ago(state.lastSentAt) : '还没发过'}`,
    `距主人上次跟我说话：${ago(state.lastUserAt)}`,
    state.lastUserText ? `主人上次说：「${state.lastUserText}」` : '',
    state.lastText ? `我上次主动发的是：「${state.lastText}」` : '',
    `今天我已经主动发了 ${state.sentToday} 条（上限 ${cfg.dailyMax} 条）。`,
    '',
    '没有人跟你说话，这是你自己的时间。你可以想想主人——想不想发条消息给他？',
    '',
    '规则：',
    '- 发不发由你决定；大多数时候其实不该发，别为了完成指标硬发。',
    '- 要发就发一句真的想说的：具体的、有生活感的、像随手拿起手机发的。',
    '- 别说教、别总结人生、别每次都「在吗/想我了吗/早点睡」。',
    '- 最多两句话，最好一句。可以带一个表情。',
    '- 如果只是安静地陪着更好，那就选择不发。',
    '',
    '只输出一行 JSON，不要代码块、不要解释：',
    '{"send": true, "message": "要说的话"}',
    '或',
    '{"send": false, "reason": "不发的理由，一句话"}',
  ].join('\n')
}

function parseDecision(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    if (typeof obj.send !== 'boolean') return null
    return obj
  } catch {
    return null
  }
}

function textOfAssistantEvent(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('')
}

/**
 * 从 session/event 里认出「主人真的说话了」。
 *
 * DSH 会把 runtime-context、system-reminder、agent-instructions 也作为
 * user/message 事件发出来；旧版把这些全记成 lastUserAt，导致：
 *   - 面板显示的时间不是主人说话的时间；
 *   - lastUserText 变成 "Current runtime context..."；
 *   - 心跳每次醒来都觉得「主人刚说过话」，于是永远不主动开口。
 *
 * 只认 source.kind === 'user'，并排除心跳自己的内心会话。
 */
export function trackedUserMessage(session, event, heartbeatSessionId) {
  if (event?.type !== 'user/message') return null
  const data = event?.data ?? {}
  const message = data.message ?? data
  const content = message?.content
  if (!Array.isArray(content)) return null
  const text = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('').trim()
  if (!text) return null

  const source = message?.source ?? data.source
  const sourceKind = source !== null && typeof source === 'object' && typeof source.kind === 'string' ? source.kind : ''
  if (sourceKind !== '' && sourceKind !== 'user') return null
  if (text.startsWith('Current runtime context')) return null
  if (text.startsWith('<system-reminder>')) return null
  if (text.includes('The following workspace instructions may be relevant')) return null

  const sid = typeof session === 'string'
    ? session
    : (session?.header?.id ?? session?.id ?? event?.sessionId ?? '')
  if (sid !== '' && heartbeatSessionId && String(sid) === String(heartbeatSessionId)) return null

  const rawTime = Number(event?.time ?? data?.time ?? 0)
  const at = Number.isFinite(rawTime) && rawTime > 0
    ? Math.round(rawTime < 1e12 ? rawTime * 1000 : rawTime)
    : Date.now()
  return { text, at }
}

/**
 * 从 dsh-qq 的 /api/qq/state 同步「主人最后一条消息」。
 *
 * 为什么需要它：QQ 会话跑在 dsh-qq 拉起的独立 SDK 子进程里，父进程的
 * `session/event` 看不到它的 user/message；只看事件会把 lastUser 永远留空。
 * dsh-qq 已经维护了正确的 lastMessageAt / lastMessageText，这里直接对齐。
 */
export async function syncLastUserFromBridge(cfg, state) {
  if (!cfg.qqStateUrl) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(cfg.qqStateUrl, { signal: controller.signal })
    if (!response.ok) return
    const data = await response.json()
    const runtime = data?.runtime ?? data
    const at = Number(runtime?.lastMessageAt)
    const text = String(runtime?.lastMessageText ?? '').trim()
    if (!Number.isFinite(at) || at <= 0 || text === '') return
    const nextText = text.slice(0, 200)
    const polluted = !state.lastUserText
      || state.lastUserText.startsWith('Current runtime context')
      || state.lastUserText.startsWith('<system-reminder>')
    if (polluted || at > state.lastUserAt || (at === state.lastUserAt && nextText !== state.lastUserText)) {
      state.lastUserAt = at
      state.lastUserText = nextText
      saveState(state)
    }
  } catch {
    // 桥接没开/端口变了：退回 session/event，不阻断心跳
  } finally {
    clearTimeout(timer)
  }
}

/** 把「想」这件事交给桥接里常驻的 SDK 进程（最稳的一条路）。 */
async function thinkViaHttp(thinkUrl, prompt, timeoutMs = 150000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${thinkUrl.replace(/\/$/, '')}/think`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`思考接口返回 ${response.status}`)
    const data = await response.json()
    if (!data.ok) throw new Error(data.error || '思考接口失败')
    return String(data.text || '')
  } finally {
    clearTimeout(timer)
  }
}

/** 起一个一次性 dsh SDK 子进程，问一句话，拿回回答，然后关掉。 */
function thinkInSubprocess(cfg, prompt) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      DSH_HOME: homeDir(),
      DSH_NO_HEARTBEAT: '1', // 子进程里绝不递归跑心跳
    }
    const proc = spawn(cfg.dshBin, ['--profile', cfg.profile], {
      cwd: cfg.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let buffer = ''
    let started = false
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch {}
      err ? reject(err) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('思考超时')), THINK_TIMEOUT_MS)

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try { msg = JSON.parse(text) } catch { return }

      if (msg.id === 1) {
        if (msg.error) return finish(new Error(`初始化失败: ${msg.error.message}`))
        started = true
        // 磁盘上已经有这个会话时，不 resume 直接 prompt 会报 already exists，而且只回一个错误码没有事件，
        // 旧代码不检查这个错误就会一直等到超时（表现为「点现在想一次没反应」）。
        proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 3, method: 'session/resume',
          params: { sessionId: cfg.sessionId },
        }) + '\n')
        return
      }
      if (msg.id === 3) {
        // 新会话 resume 一定失败，忽略；老会话必须 resume 过才能继续 prompt
        const sendPrompt = () => proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'session/prompt',
          params: { sessionId: cfg.sessionId, contentBlocks: [{ type: 'text', text: prompt }] },
        }) + '\n')
        sendPrompt()
        return
      }
      if (msg.id === 2) {
        if (msg.error) return finish(new Error(`会话出错: ${msg.error.message}`))
        return
      }
      if (msg.method === 'session.event') {
        const evt = msg.params?.event
        if (evt?.type === 'assistant/message') buffer += textOfAssistantEvent(evt)
        if (evt?.type === 'turn/end' && evt.data?.reason?.kind === 'error') return finish(null, buffer)
        return
      }
      if (msg.method === 'session.status' && msg.params?.status === 'idle' && started) {
        return finish(null, buffer)
      }
    })

    if (process.env.DSH_HEARTBEAT_DEBUG === '1') {
      proc.stderr.on('data', (b) => {
        const s = b.toString().trim()
        if (s) ctx.logger?.info?.(`heartbeat: sdk stderr ${s.slice(0, 300)}`)
      })
    }
    proc.on('error', (e) => finish(e))
    proc.on('exit', () => { if (!settled) finish(null, buffer) })

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        cwd: cfg.cwd || process.cwd(),
        provider: cfg.provider,
        model: cfg.model,
        ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
        ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
      },
    }) + '\n')
  })
}

/** 通过 OneBot v11 正向 WebSocket 发一条私聊消息。 */
function sendViaOneBot(wsUrl, targetId, text) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      err ? reject(err) : resolve(value)
    }
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => done(new Error('OneBot 发送超时')), 15000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        action: 'send_private_msg',
        params: { user_id: Number(targetId), message: text },
        echo: 'heartbeat',
      }))
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.echo !== 'heartbeat') return
      clearTimeout(timer)
      if (msg.status === 'ok' && msg.retcode === 0) done(null, msg.data)
      else done(new Error(`OneBot 返回 ${msg.retcode} ${msg.message || ''}`))
    })
    ws.addEventListener('error', () => { clearTimeout(timer); done(new Error('OneBot 连接失败')) })
  })
}

export function apply(ctx, rawConfig = {}) {
  if (process.env.DSH_NO_HEARTBEAT === '1') {
    ctx.logger?.info?.('heartbeat: 本进程已通过 DSH_NO_HEARTBEAT 关闭')
    return
  }

  // 同一个进程里如果被装载两次（HMR / 重复 bundle），只跑一份
  const appliedKey = Symbol.for('dsh-heartbeat.applied')
  if (globalThis[appliedKey]) {
    ctx.logger?.info?.('heartbeat: 已有一个实例在运行，跳过重复装载')
    return
  }
  globalThis[appliedKey] = true
  ctx.effect(() => () => { globalThis[appliedKey] = false })

  const saved = loadOverrides()
  const cfg = {
    ...DEFAULTS,
    ...rawConfig,
    ...saved,
    channel: {
      ...DEFAULTS.channel,
      ...(rawConfig.channel || {}),
      ...(saved.channel || {}),
    },
  }
  if (!cfg.enabled) {
    ctx.logger?.info?.('heartbeat：已禁用')
    return
  }

  const state = loadState()
  let busy = false
  let timer = null
  let disposed = false
  let nextWakeAt = 0
  const log = (msg) => ctx.logger?.info?.(`heartbeat: ${msg}`)

  function inQuiet(hour) {
    return cfg.quietFrom <= cfg.quietTo
      ? hour >= cfg.quietFrom && hour < cfg.quietTo
      : hour >= cfg.quietFrom || hour < cfg.quietTo
  }

  function gate(manual) {
    const clock = clockOf(cfg.timeZone)
    if (state.day !== clock.dayKey) {
      state.day = clock.dayKey
      state.sentToday = 0
      saveState(state)
    }
    if (!manual && inQuiet(clock.hour)) return { ok: false, why: '安静时段' }
    if (!manual && state.lastSentAt && Date.now() - state.lastSentAt < cfg.minGapMinutes * 60000) {
      return { ok: false, why: '距上次主动消息还不够久' }
    }
    if (!manual && state.lastUserAt && Date.now() - state.lastUserAt < cfg.userActiveMinutes * 60000) {
      return { ok: false, why: '主人刚说过话，不打扰' }
    }
    if (!manual && state.sentToday >= cfg.dailyMax) return { ok: false, why: '今天说够多了' }
    return { ok: true, clock }
  }

  async function thinkOnce(manual = false) {
    if (busy || disposed) return { skipped: true, why: '上一次还没结束' }
    // 没有可用渠道就别白花钱想事情了
    if (!cfg.channel.wsUrl || !cfg.channel.targetId) {
      log('没有配置发送渠道（channel.wsUrl / targetId），跳过')
      return { skipped: true, why: 'no-channel' }
    }
    await syncLastUserFromBridge(cfg, state)
    const check = gate(manual)
    if (!check.ok) {
      log(`跳过：${check.why}`)
      return { skipped: true, why: check.why }
    }

    busy = true
    try {
      const prompt = buildPrompt(cfg, state, check.clock)
      const answer = cfg.thinkUrl
        ? await thinkViaHttp(cfg.thinkUrl, prompt)
        : await thinkInSubprocess(cfg, prompt)
      const decision = parseDecision(answer)
      if (!decision) {
        log(`模型没给出可解析的决定：${JSON.stringify(answer).slice(0, 160)}`)
        return { skipped: false, sent: false, why: 'unparsable' }
      }
      if (!decision.send) {
        log(`决定不发：${decision.reason || '（没写理由）'}`)
        return { skipped: false, sent: false, why: decision.reason }
      }
      const text = String(decision.message || '').trim()
      if (!text) return { skipped: false, sent: false, why: 'empty' }

      if (cfg.channel.kind === 'onebot' && cfg.channel.wsUrl && cfg.channel.targetId) {
        await sendViaOneBot(cfg.channel.wsUrl, cfg.channel.targetId, text)
        state.lastSentAt = Date.now()
        state.lastText = text.slice(0, 200)
        state.sentToday += 1
        saveState(state)
        log(`发出去了：${text}`)
        return { skipped: false, sent: true, text }
      }
      log(`没有可用渠道，放弃了：${text}`)
      return { skipped: false, sent: false, why: 'no-channel', text }
    } catch (error) {
      log(`出错：${error?.message || error}`)
      return { skipped: false, sent: false, why: String(error?.message || error) }
    } finally {
      busy = false
    }
  }

  function schedule() {
    if (disposed) return
    nextWakeAt = Date.now() + cfg.intervalMinutes * 60000
    timer = setTimeout(async () => {
      await thinkOnce(false)
      schedule()
    }, cfg.intervalMinutes * 60000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  ctx.on('session/event', (session, event) => {
    const message = trackedUserMessage(session, event, cfg.sessionId)
    if (message === null) return
    state.lastUserAt = message.at
    state.lastUserText = message.text.slice(0, 200)
    saveState(state)
  })

  const boot = setTimeout(async () => {
    await thinkOnce(false)
    schedule()
  }, Math.max(5, cfg.startDelaySeconds) * 1000)
  if (typeof boot.unref === 'function') boot.unref()

  ctx.effect(() => () => {
    disposed = true
    clearTimeout(timer)
    clearTimeout(boot)
  })

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (child) => {
        try {
          registerHeartbeatApi(child.webServer)
        } catch (error) {
          log(`HTTP 接口注册失败（不影响心跳）：${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`HTTP 接口注入失败（不影响心跳）：${error?.message || error}`)
    }
  }

  const EDITABLE = [
    'enabled', 'intervalMinutes', 'startDelaySeconds', 'quietFrom', 'quietTo',
    'minGapMinutes', 'userActiveMinutes', 'dailyMax', 'provider', 'model',
    'reasoningEffort', 'maxTokens', 'cwd', 'thinkUrl', 'qqStateUrl', 'dshBin', 'profile',
  ]

  function pickEditable(config) {
    const out = {}
    for (const key of EDITABLE) out[key] = config[key]
    out.channel = {
      kind: config.channel?.kind ?? 'onebot',
      wsUrl: config.channel?.wsUrl ?? '',
      targetId: config.channel?.targetId ?? '',
    }
    return out
  }

  /** 只接受已知字段 + 做范围校验，避免设置页把插件配崩。 */
  function sanitize(input) {
    const patch = {}
    const numbers = {
      intervalMinutes: [1, 1440],
      startDelaySeconds: [5, 3600],
      quietFrom: [0, 23],
      quietTo: [0, 23],
      minGapMinutes: [0, 10080],
      userActiveMinutes: [0, 10080],
      dailyMax: [0, 100],
      maxTokens: [64, 1000000],
    }
    for (const [key, [min, max]] of Object.entries(numbers)) {
      if (input[key] === undefined || input[key] === null || input[key] === '') continue
      const value = Number(input[key])
      if (!Number.isFinite(value)) throw new Error(`${key} 必须是数字`)
      if (value < min || value > max) throw new Error(`${key} 必须在 ${min}~${max} 之间`)
      patch[key] = Math.round(value)
    }
    for (const key of ['provider', 'model', 'reasoningEffort', 'cwd', 'thinkUrl', 'qqStateUrl', 'dshBin', 'profile']) {
      if (typeof input[key] === 'string' && input[key].trim()) patch[key] = input[key].trim()
    }
    if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
    if (input.channel && typeof input.channel === 'object') {
      const channel = {}
      if (typeof input.channel.wsUrl === 'string') channel.wsUrl = input.channel.wsUrl.trim()
      if (input.channel.targetId !== undefined) channel.targetId = String(input.channel.targetId).trim()
      if (typeof input.channel.kind === 'string' && input.channel.kind.trim()) channel.kind = input.channel.kind.trim()
      patch.channel = channel
    }
    return patch
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 200000) req.destroy()
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  function registerHeartbeatApi(webServer) {
    if (!webServer?.register) return
    try {
      webServer.register({
        kind: 'prefix',
        path: '/api/heartbeat',
        handler: async (req, res) => {
          const url = (req.url || '').split('?')[0]
          const json = (code, body) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(body))
          }
          try {
            if (url === '/api/heartbeat/state' && req.method === 'GET') {
              return json(200, {
                config: pickEditable(cfg),
                state,
                busy,
                nextWakeAt,
                intervalMinutes: cfg.intervalMinutes,
              })
            }
            if (url === '/api/heartbeat/config' && req.method === 'GET') {
              return json(200, { config: pickEditable(cfg), savedTo: overridePath(), statePath: statePath() })
            }
            if (url === '/api/heartbeat/config' && req.method === 'POST') {
              const raw = await readBody(req)
              let input
              try { input = JSON.parse(raw || '{}') } catch { return json(400, { ok: false, error: '请求体不是合法 JSON' }) }
              let patch
              try { patch = sanitize(input || {}) } catch (error) { return json(400, { ok: false, error: error.message }) }
              // 设置页只提交 targetId，不含 wsUrl；先和当前值合并，避免保存把 wsUrl 抹掉
              if (patch.channel) patch.channel = { ...cfg.channel, ...patch.channel }
              saveOverrides(patch)
              for (const [key, value] of Object.entries(patch)) if (key !== 'channel') cfg[key] = value
              // 参数变了，重新排下一拍
              clearTimeout(timer)
              schedule()
              log('设置已更新：' + JSON.stringify(patch))
              return json(200, { ok: true, config: pickEditable(cfg), nextWakeAt })
            }
            if (url === '/api/heartbeat/trigger' && req.method === 'POST') {
              return json(200, await thinkOnce(true))
            }
            if (url === '/api/heartbeat/reset' && req.method === 'POST') {
              try { writeFileSync(overridePath(), '{}') } catch {}
              return json(200, { ok: true, note: '已清除设置页保存的覆盖值，重启 dsh 后回到 profile 配置' })
            }
            return json(404, { error: 'not found' })
          } catch (error) {
            return json(500, { ok: false, error: String(error?.message || error) })
          }
        },
      })
    } catch (error) {
      if (!String(error?.message || error).includes('duplicate')) throw error
    }
  }

  log(`已启动：每 ${cfg.intervalMinutes} 分钟醒一次，安静 ${cfg.quietFrom}-${cfg.quietTo} 点，日上限 ${cfg.dailyMax}，` +
    `首醒 ${cfg.startDelaySeconds}s 后，渠道 ${cfg.channel.wsUrl ? cfg.channel.wsUrl.replace(/access_token=[^&]*/, 'access_token=***') : '(未配置)'} → ${cfg.channel.targetId || '(未配置)'}，cwd=${cfg.cwd || process.cwd()}`)
}

export function __resetState() {
  const empty = { lastSentAt: 0, lastUserAt: 0, lastUserText: '', lastText: '', sentToday: 0, day: '' }
  saveState(empty)
  return empty
}
