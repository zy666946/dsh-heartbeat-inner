import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { trackedUserMessage, syncLastUserFromBridge, computeExpectation, readLastTurn } from '../lib/index.js'

function event(text, { source = 'user', time = 1793320000000, nested = true } = {}) {
  const message = {
    content: [{ type: 'text', text }],
    source: { kind: source },
  }
  return {
    type: 'user/message',
    time,
    data: nested ? { message } : { ...message },
  }
}

test('只记录真正的主人消息', () => {
  const msg = trackedUserMessage({ header: { id: 'qq-1' } }, event('  爸爸今天有点累  '), 'session-heartbeat-inner')
  assert.deepEqual(msg, { text: '爸爸今天有点累', at: 1793320000000 })
})

test('runtime-context / system-reminder / agent-instructions 不算主人说话', () => {
  assert.equal(trackedUserMessage({}, event('Current runtime context. ...'), ''), null)
  assert.equal(trackedUserMessage({}, event('<system-reminder> ...'), ''), null)
  assert.equal(trackedUserMessage({}, event('随便说点', { source: 'agent-instructions' }), ''), null)
  assert.equal(trackedUserMessage({}, event('随便说点', { source: 'runtime-context' }), ''), null)
  assert.equal(trackedUserMessage({}, event('The following workspace instructions may be relevant'), ''), null)
})

test('心跳自己的内心会话不算主人说话', () => {
  const own = event('【安静的内心时刻】现在……')
  assert.equal(trackedUserMessage({ header: { id: 'session-heartbeat-inner' } }, own, 'session-heartbeat-inner'), null)
  assert.equal(trackedUserMessage({ id: 'session-heartbeat-inner' }, own, 'session-heartbeat-inner'), null)
})

test('兼容 data.message 和 data 两种事件形状，秒级时间会转毫秒', () => {
  const flat = trackedUserMessage({}, event('扁平事件', { nested: false, time: 1793320000 }), '')
  assert.equal(flat.text, '扁平事件')
  assert.equal(flat.at, 1793320000000)
})

test('没有时间戳时用当前时间兜底', () => {
  const before = Date.now()
  const msg = trackedUserMessage({}, event('没有时间', { time: 0 }), '')
  assert.ok(msg.at >= before && msg.at <= Date.now())
})

test('从 dsh-qq 的 /api/qq/state 同步主人最后一条消息', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      runtime: { lastMessageAt: 1793324675392, lastMessageText: '现在立即重启吧' },
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'heartbeat-sync-'))
  const state = { lastSentAt: 0, lastUserAt: 0, lastUserText: '', lastText: '', sentToday: 0, day: '' }
  try {
    await syncLastUserFromBridge({ qqStateUrl: `http://127.0.0.1:${port}/api/qq/state` }, state)
    assert.equal(state.lastUserAt, 1793324675392)
    assert.equal(state.lastUserText, '现在立即重启吧')
  } finally {
    process.env.DSH_HOME = previousHome
    await new Promise((resolve) => server.close(resolve))
  }
})

test('期待时间：亲近的话更短，正事更长', () => {
  const cfg = { timeZone: 'Asia/Shanghai', maxAttempts: 3 }
  const now = Date.parse('2026-10-30T15:00:00+08:00')
  const warm = computeExpectation(cfg, { attempts: 0 }, { userText: '爸爸今天有点难过，想你了' }, now)
  const work = computeExpectation(cfg, { attempts: 0 }, { userText: '帮我看看这个代码报错' }, now)
  assert.ok(warm.at > now)
  assert.ok(work.at > warm.at, '正事应该比亲近的话等更久')
})

test('期待时间：主动多次后停止，深夜顺延到早上', () => {
  const cfg = { timeZone: 'Asia/Shanghai', maxAttempts: 3 }
  const stopped = computeExpectation(cfg, { attempts: 3 }, { userText: '在吗' }, Date.now())
  assert.equal(stopped.at, 0)
  assert.match(stopped.reason, /等主人先开口/)

  const night = Date.parse('2026-10-30T23:30:00+08:00')
  const exp = computeExpectation(cfg, { attempts: 0 }, { userText: '晚安' }, night)
  assert.ok(exp.at - night >= 7 * 3600 * 1000, '深夜不应马上发')
})


test('从 last-turn.json 读 dsh-qq 写下的这一轮', () => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'heartbeat-turn-'))
  process.env.DSH_HOME = home
  try {
    mkdirSync(join(home, 'heartbeat'), { recursive: true })
    writeFileSync(join(home, 'heartbeat', 'last-turn.json'), JSON.stringify({
      userAt: 1793320000000,
      userText: '今天有点累',
      replyAt: 1793320060000,
      replyText: '那先歇会儿，我在。',
    }))
    const turn = readLastTurn()
    assert.equal(turn.userText, '今天有点累')
    assert.equal(turn.replyText, '那先歇会儿，我在。')
    assert.equal(turn.replyAt, 1793320060000)
  } finally {
    process.env.DSH_HOME = previousHome
  }
})
