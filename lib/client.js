/**
 * dsh-heartbeat —— 浏览器半侧：设置 → 「心跳」页
 *
 * 手写 __ModuleLoader__ bundle（无构建工具），只 require 宿主提供的 react。
 * 与宿主只走同源 HTTP（/api/heartbeat/*）。
 *
 * 页面能力：
 *  - 看状态：今天发了几条、上次发了什么、下次什么时候醒来
 *  - 改参数：开关 / 间隔 / 安静时段 / 最小间隔 / 活跃窗口 / 日上限 / 目标 QQ / 思考接口 / 工作目录
 *  - 立即想一次（手动触发，绕过安静时段）
 */
window.__ModuleLoader__.load({
  id: 'dsh-heartbeat-inner',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var API = '/api/heartbeat'
    var NS = 'dsh-heartbeat'

    // ---- 同源 HTTP --------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var message = data && data.error ? data.error : ('HTTP ' + res.status)
          var error = new Error(message)
          error.status = res.status
          throw error
        }
        return data
      })
    }
    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    // ---- 小工具 -----------------------------------------------------------

    function pad(n) { return n < 10 ? '0' + n : '' + n }
    function fmtTime(ms) {
      if (!ms) return '—'
      var d = new Date(ms)
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    function ago(ms) {
      if (!ms) return '还没有过'
      var diff = Date.now() - ms
      if (diff < 0) return fmtTime(ms) + ' 后'
      var m = Math.round(diff / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return m + ' 分钟前'
      var hh = Math.floor(m / 60)
      if (hh < 24) return hh + ' 小时 ' + (m % 60) + ' 分前'
      return Math.floor(hh / 24) + ' 天前'
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.hb-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#241f18);}',
      '.hb-card{background:var(--dsw-alias-bg-secondary,#fbf8f2);border:1px solid var(--dsw-alias-border-secondary,#e6dfd2);border-radius:14px;padding:14px 16px;}',
      '.hb-title{font-size:13.5px;font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:8px;}',
      '.hb-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success,#2f6b46);flex:0 0 auto;}',
      '.hb-dot-off{background:var(--dsw-alias-label-tertiary,#9a9084);}',
      '.hb-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-secondary,#eee7da);}',
      '.hb-row:last-child{border-bottom:0;}',
      '.hb-k{color:var(--dsw-alias-label-secondary,#6f6558);font-size:12.5px;}',
      '.hb-v{font-size:12.5px;text-align:right;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.hb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;}',
      '.hb-field{display:flex;flex-direction:column;gap:5px;}',
      '.hb-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.hb-input{height:32px;border-radius:9px;border:1px solid var(--dsw-alias-border-secondary,#ddd5c6);background:var(--dsw-alias-bg-primary,#fffdf8);color:inherit;padding:0 10px;font-size:12.5px;outline:none;min-width:0;}',
      '.hb-input:focus{border-color:var(--dsw-alias-brand-primary,#241f18);}',
      '.hb-toggle{display:flex;align-items:center;gap:9px;cursor:pointer;user-select:none;}',
      '.hb-toggle input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#241f18);cursor:pointer;}',
      '.hb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.hb-btn{height:32px;padding:0 15px;border-radius:9px;border:1px solid var(--dsw-alias-border-secondary,#ddd5c6);background:var(--dsw-alias-bg-primary,#fffdf8);color:inherit;font-size:12.5px;cursor:pointer;}',
      '.hb-btn:hover{background:var(--dsw-alias-bg-tertiary,#f2ece0);}',
      '.hb-btn:disabled{opacity:.5;cursor:default;}',
      '.hb-btn-primary{background:var(--dsw-alias-brand-primary,#241f18);border-color:transparent;color:var(--dsw-alias-label-on-brand,#fffdf8);}',
      '.hb-btn-primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary,#241f18);}',
      '.hb-msg{font-size:12.5px;border-radius:10px;padding:9px 12px;line-height:1.6;border:1px solid var(--dsw-alias-border-secondary,#e0d7c8);background:var(--dsw-alias-bg-primary,#fffdf8);}',
      '.hb-msg-ok{color:var(--dsw-alias-state-success,#2f6b46);border-color:rgba(47,107,70,.35);}',
      '.hb-msg-err{color:var(--dsw-alias-state-error,#a83a2c);border-color:rgba(168,58,44,.35);}',
      '.hb-quote{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#6f6558);background:var(--dsw-alias-bg-primary,#fffdf8);border-left:3px solid var(--dsw-alias-border-secondary,#ddd5c6);border-radius:0 8px 8px 0;padding:8px 11px;white-space:pre-wrap;word-break:break-word;}',
      '.hb-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9084);line-height:1.6;}',
      '.hb-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9a9084);padding:18px 0;}',
    ].join('')

    // ---- 页面 -------------------------------------------------------------

    function HeartbeatSection(props) {
      var [state, setState] = useState(null)
      var [form, setForm] = useState(null)
      var [error, setError] = useState(null)
      var [notice, setNotice] = useState(null)
      var [saving, setSaving] = useState(false)
      var [thinking, setThinking] = useState(false)

      var load = useCallback(function () {
        return apiGet('/state').then(function (data) {
          setState(data)
          setError(null)
          return data
        }).catch(function (e) {
          setError(e.message)
        })
      }, [])

      useEffect(function () { load() }, [load])

      // 服务端配置回来后灌进表单（只在首次/刷新时覆盖，避免打字被冲掉）
      useEffect(function () {
        if (!state || !state.config) return
        if (form !== null) return
        var c = state.config
        setForm({
          enabled: c.enabled !== false,
          intervalMinutes: c.intervalMinutes,
          quietFrom: c.quietFrom,
          quietTo: c.quietTo,
          minGapMinutes: c.minGapMinutes,
          userActiveMinutes: c.userActiveMinutes,
          dailyMax: c.dailyMax,
          targetId: (c.channel && c.channel.targetId) || '',
          thinkUrl: c.thinkUrl || '',
          cwd: c.cwd || '',
        })
      }, [state, form])

      function update(key, value) {
        setForm(function (prev) {
          var next = {}
          for (var k in prev) next[k] = prev[k]
          next[key] = value
          return next
        })
      }

      function save() {
        if (!form) return
        setSaving(true)
        setNotice(null)
        apiPost('/config', {
          enabled: form.enabled,
          intervalMinutes: form.intervalMinutes,
          quietFrom: form.quietFrom,
          quietTo: form.quietTo,
          minGapMinutes: form.minGapMinutes,
          userActiveMinutes: form.userActiveMinutes,
          dailyMax: form.dailyMax,
          thinkUrl: form.thinkUrl,
          cwd: form.cwd,
          channel: { kind: 'onebot', targetId: form.targetId },
        }).then(function (res) {
          setNotice({ kind: 'ok', text: '已保存并立即生效（下一觉：' + fmtTime(res.nextWakeAt) + '）' })
          return load()
        }).catch(function (e) {
          setNotice({ kind: 'err', text: '保存失败：' + e.message })
        }).then(function () { setSaving(false) })
      }

      function thinkNow() {
        setThinking(true)
        setNotice(null)
        apiPost('/trigger', {}).then(function (res) {
          var text
          if (res.skipped) text = '这次跳过了：' + (res.why || '原因不明')
          else if (res.sent) text = '发出去了：「' + res.text + '」'
          else text = '它想了想，决定不发' + (res.why ? '：' + res.why : '')
          setNotice({ kind: 'ok', text: text })
          return load()
        }).catch(function (e) {
          setNotice({ kind: 'err', text: '触发失败：' + e.message })
        }).then(function () { setThinking(false) })
      }

      if (error) {
        return h('div', { className: 'hb-root' },
          h('div', { className: 'hb-msg hb-msg-err' }, '读不到心跳状态：' + error),
          h('div', { className: 'hb-hint' }, '确认 dsh-heartbeat 插件已加载（/root/.dsh/plugins/dsh-heartbeat），并在 web profile 的 bundles 里。'),
        )
      }
      if (!state || !form) return h('div', { className: 'hb-loading' }, '正在读取心跳状态…')

      var todayLine = (state.state.sentToday || 0) + ' / ' + form.dailyMax + ' 条'
      var nextLine = state.nextWakeAt ? ago(state.nextWakeAt) : '—'

      return h('div', { className: 'hb-root' },

        // 状态卡
        h('div', { className: 'hb-card' },
          h('div', { className: 'hb-title' },
            h('span', { className: 'hb-dot' + (form.enabled ? '' : ' hb-dot-off') }),
            form.enabled ? '心跳运行中' : '心跳已关闭'),
          h('div', { className: 'hb-row' },
            h('span', { className: 'hb-k' }, '今天已主动发'), h('span', { className: 'hb-v' }, todayLine)),
          h('div', { className: 'hb-row' },
            h('span', { className: 'hb-k' }, '下次醒来'), h('span', { className: 'hb-v' }, nextLine)),
          h('div', { className: 'hb-row' },
            h('span', { className: 'hb-k' }, '上次主动发'), h('span', { className: 'hb-v' }, ago(state.state.lastSentAt))),
          h('div', { className: 'hb-row' },
            h('span', { className: 'hb-k' }, '你上次说话'), h('span', { className: 'hb-v' }, ago(state.state.lastUserAt))),
          state.state.lastText ? h('div', { style: { marginTop: '10px' } },
            h('div', { className: 'hb-label', style: { marginBottom: '5px' } }, '它上次说的话'),
            h('div', { className: 'hb-quote' }, state.state.lastText)) : null,
          state.state.lastUserText ? h('div', { style: { marginTop: '10px' } },
            h('div', { className: 'hb-label', style: { marginBottom: '5px' } }, '你上次说的话'),
            h('div', { className: 'hb-quote' }, state.state.lastUserText)) : null,
        ),

        // 参数
        h('div', { className: 'hb-card' },
          h('div', { className: 'hb-title' }, '参数'),
          h('label', { className: 'hb-toggle', style: { paddingBottom: '10px' } },
            h('input', {
              type: 'checkbox',
              checked: form.enabled,
              onChange: function (e) { update('enabled', e.target.checked) },
            }),
            h('span', null, '启用主动心跳（关掉后它只会回应你，不会自己找你）')),

          h('div', { className: 'hb-grid' },
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '唤醒间隔（分钟）'),
              h('input', {
                className: 'hb-input', type: 'number', min: 1, max: 1440,
                value: form.intervalMinutes,
                onChange: function (e) { update('intervalMinutes', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '安静时段起（0-23 点）'),
              h('input', {
                className: 'hb-input', type: 'number', min: 0, max: 23,
                value: form.quietFrom,
                onChange: function (e) { update('quietFrom', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '安静时段止（0-23 点）'),
              h('input', {
                className: 'hb-input', type: 'number', min: 0, max: 23,
                value: form.quietTo,
                onChange: function (e) { update('quietTo', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '两次主动消息最小间隔（分钟）'),
              h('input', {
                className: 'hb-input', type: 'number', min: 0,
                value: form.minGapMinutes,
                onChange: function (e) { update('minGapMinutes', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '你刚说话后静默（分钟）'),
              h('input', {
                className: 'hb-input', type: 'number', min: 0,
                value: form.userActiveMinutes,
                onChange: function (e) { update('userActiveMinutes', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '每天最多发（条）'),
              h('input', {
                className: 'hb-input', type: 'number', min: 0, max: 100,
                value: form.dailyMax,
                onChange: function (e) { update('dailyMax', e.target.value) },
              })),
          ),

          h('div', { className: 'hb-grid', style: { marginTop: '10px' } },
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '发给哪个 QQ'),
              h('input', {
                className: 'hb-input', type: 'text', placeholder: '例如 10001',
                value: form.targetId,
                onChange: function (e) { update('targetId', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '思考接口（桥接 HTTP）'),
              h('input', {
                className: 'hb-input', type: 'text', placeholder: 'http://127.0.0.1:3002',
                value: form.thinkUrl,
                onChange: function (e) { update('thinkUrl', e.target.value) },
              })),
            h('div', { className: 'hb-field' },
              h('span', { className: 'hb-label' }, '工作目录（内心会话的 cwd）'),
              h('input', {
                className: 'hb-input', type: 'text', placeholder: '/www/...',
                value: form.cwd,
                onChange: function (e) { update('cwd', e.target.value) },
              })),
          ),

          h('div', { className: 'hb-hint', style: { marginTop: '10px' } },
            '安静时段可以跨零点：起 23、止 7 表示 23:00 到次日 07:00 之间不主动打扰。'),
        ),

        // 操作
        h('div', { className: 'hb-actions' },
          h('button', { className: 'hb-btn hb-btn-primary', disabled: saving, onClick: save },
            saving ? '保存中…' : '保存并生效'),
          h('button', { className: 'hb-btn', disabled: thinking, onClick: thinkNow },
            thinking ? '正在想…' : '现在就想一次'),
          h('button', { className: 'hb-btn', onClick: function () { setForm(null); load() } }, '重新读取'),
          h('span', { className: 'hb-hint' }, '保存会写入 $DSH_HOME/heartbeat/config.json，重启后依然有效'),
        ),

        notice ? h('div', { className: 'hb-msg ' + (notice.kind === 'ok' ? 'hb-msg-ok' : 'hb-msg-err') }, notice.text) : null,
      )
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-heartbeat-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-heartbeat: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'heartbeat',
          order: 47,
          locale: NS,
          label: function () { return '心跳' },
        }, function (props) {
          return h(HeartbeatSection, props || {})
        })
      })
    }

    module.exports = {
      name: 'heartbeat',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
