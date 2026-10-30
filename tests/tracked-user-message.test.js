import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { trackedUserMessage, syncLastUserFromBridge } from '../lib/index.js'

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
