# dsh-heartbeat-inner

[![Release](https://img.shields.io/github/v/release/zy666946/dsh-heartbeat-inner?include_prereleases)](https://github.com/zy666946/dsh-heartbeat-inner/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个**主动心跳**插件：
它会定时醒来，自己判断「现在要不要主动找主人说句话」——不是机械的定时问候，而是**大多数时候不发**。

> 一句话概括：让 AI 有自己的节律，而不是只在被叫时才有反应。

## 它和「定时任务」有什么不一样

| | 定时任务 | dsh-heartbeat |
|---|---|---|
| 触发 | 到点必发 | 到点先**想**，再决定发不发 |
| 内容 | 模板 / 复读 | 结合「多久没聊、你上次说了什么、现在几点」现想一句 |
| 克制 | 需要人工配 | 内建四道刹车，多数时候选择沉默 |
| 记忆 | 无 | 内心会话持久化，上次想过什么还记得 |

真实产生的两种日志：

```
[heartbeat] 发出去了：在呢在呢，刚把水杯放下就看到你喊我了 🐟
[heartbeat] 决定不发：他刚问完话，聊天正热着，我等着顺着那句接就行，不用再单独塞一条过去
```

## 工作方式

```
每 N 分钟醒来
   │
   ├─ 安静时段？ ────────────────→ 睡回去
   ├─ 距上次主动发 < 最小间隔？ ──→ 睡回去
   ├─ 主人刚说过话？ ────────────→ 睡回去
   ├─ 今天发够上限了？ ──────────→ 睡回去
   │
   ▼
POST 思考接口（或本地子进程）→ 模型输出 JSON
   │
   ├─ {"send": false, "reason": "…"}  → 记一笔，睡回去
   └─ {"send": true,  "message": "…"} → 通过 OneBot 发出去
```

## 安装

### 1. 拿到源码

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
git clone https://github.com/zy666946/dsh-heartbeat-inner "$DSH_HOME/plugins/dsh-heartbeat-inner"
```

（或者解压 release 里的 `dsh-heartbeat-inner-*.tgz` 到 `$DSH_HOME/plugins/dsh-heartbeat-inner`）

### 2. 挂进 profile

以 `web` profile 为例：

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
cd "$DSH_HOME/profiles/web"
mkdir -p node_modules
ln -sfn "$DSH_HOME/plugins/dsh-heartbeat-inner" node_modules/dsh-heartbeat-inner
```

编辑 `$DSH_HOME/profiles/web/package.json`，加两行：

```json
{
  "dependencies": {
    "dsh-heartbeat-inner": "link:../../plugins/dsh-heartbeat-inner"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-heartbeat-inner"
      ]
    }
  }
}
```

### 3. 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- id: heartbeat
  config:
    enabled: true
    intervalMinutes: 30      # 多久醒一次
    quietFrom: 0             # 安静时段（支持跨零点，23→7 表示 23:00-07:00）
    quietTo: 7
    minGapMinutes: 120       # 两次主动消息最小间隔
    userActiveMinutes: 40    # 主人刚说话后多少分钟内不打扰
    dailyMax: 5              # 每天最多主动发几条
    cwd: "/path/to/your/workspace"
    thinkUrl: "http://127.0.0.1:3002"   # 见下节
    channel:
      kind: onebot
      wsUrl: "ws://127.0.0.1:3001?access_token=你的token"
      targetId: "主人的QQ号"
```

重启 dsh，然后 **设置 → 心跳** 就有可视化面板了（改完点保存即时生效，不用重启）。

## 两种「思考」引擎

### A. HTTP 引擎（推荐）

插件把 prompt 发给一个本地 HTTP 服务，由它调用模型并返回纯文本。这样可以把「想」交给一个常驻的 SDK 进程，避免每次冷启动。

**如果你装了 [dsh-qq](https://github.com/zy666946/dsh-qq)**，它的 `127.0.0.1:3002/think` 就是现成的思考接口，
`thinkUrl` 直接指向它即可，不用再单独跑一个桥接进程 —— 两个插件共享同一个常驻 SDK 会话。

没装 dsh-qq 的话，本项目自带一个参考实现 [`examples/bridge-think-endpoint.mjs`](examples/bridge-think-endpoint.mjs)：
它就是一个 `POST /think` 接口，内部复用 `dsh --profile sdk` 的会话。

```bash
# 请求
curl -X POST http://127.0.0.1:3002/think \
  -H 'content-type: application/json' \
  -d '{"prompt":"..."}'

# 响应
{"ok": true, "text": "{\"send\": false, \"reason\": \"凌晨了，别吵他\"}"}
```

### B. 子进程引擎（零依赖）

不配 `thinkUrl` 时，插件会自己 `spawn` 一个 `dsh --profile sdk`，问一句、收答案、关掉。

- 优点：不需要额外服务
- 缺点：每次多 5~10 秒冷启动；**同一个 profile 不能被两个 dsh 实例同时占用**，否则会卡在启动（建议给它单独的 profile，比如 `hb`）

```yaml
    dshBin: "/usr/local/bin/dsh"
    profile: hb          # 基于 sdk 模板初始化的独立 profile
```

## 发送渠道

目前内置 **OneBot v11 正向 WebSocket**（NapCat / LLOneBot / Lagrange 都支持）：

```yaml
    channel:
      kind: onebot
      wsUrl: "ws://127.0.0.1:3001?access_token=xxx"
      targetId: "123456789"
```

> 发送走 `send_private_msg`。如果要发群消息，改 `lib/index.js` 里 `sendViaOneBot` 的 action 即可（欢迎提 PR 做成配置项）。

## 设置页

挂进 `web` profile 后，设置里会出现「心跳」页：

- 状态：今天发了几条 / 下次醒来 / 上次说了什么
- 参数：上面那张表里的全部项
- 按钮：`保存并生效`（写盘 + 重排下一拍）、`现在就想一次`（绕过安静时段）

保存写入 `$DSH_HOME/heartbeat/config.json`，优先级高于 profile 配置，重启后保留。

对应的 HTTP 接口（同源，需登录态）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/heartbeat/state` | 状态 + 生效配置 |
| GET | `/api/heartbeat/config` | 可编辑配置 |
| POST | `/api/heartbeat/config` | 保存并热更新 |
| POST | `/api/heartbeat/trigger` | 手动想一次 |
| POST | `/api/heartbeat/reset` | 清空设置页覆盖值 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_NO_HEARTBEAT=1` | 本进程不跑心跳（给桥接等子进程用，避免抢同一个内心会话） |
| `DSH_HEARTBEAT_DEBUG=1` | 打印子进程 stderr，排查用 |

## 状态文件

```
$DSH_HOME/heartbeat/state.json    # 上次发送时间、今日计数、上次说的话
$DSH_HOME/heartbeat/config.json   # 设置页保存的覆盖值
```

删掉 `config.json` 即回到 profile 配置。

## 已知限制

- 内心会话与真实聊天会话**不共享记忆**：它记得自己想发过什么，但不知道你在另一个渠道聊了什么
- 子进程引擎在 web 服务里实测容易卡（同 profile 锁），优先用 HTTP 引擎
- 插件被装载两次时会打印 `duplicate prefix route`（已加幂等保护，正常不会出现）
- 目前只有 OneBot 渠道，且只发私聊

## 开发

```bash
node --check lib/index.js   # 服务端
node --check lib/client.js  # 浏览器端（手写 bundle，只验语法）
```

浏览器端是手写的 `__ModuleLoader__` bundle，不需要构建工具，改完重启 dsh 即可。

## License

MIT

## 排错

### 页面提示 `Failed to load plugins` / `loaded without registering "dsh-heartbeat-inner"`

0.2.0 及更早版本的 `lib/client.js` 里模块 id 写成了 `dsh-heartbeat`，
而宿主是按**包名** `dsh-heartbeat-inner` 找模块的，名字对不上 → 前端加载失败、整页白屏。

0.2.1 已修复（`id: 'dsh-heartbeat-inner'`）。升级：

```bash
cd "$DSH_HOME/plugins/dsh-heartbeat-inner" && git pull
# 或者按上面的方式重新 npm i / 解压
systemctl restart dsh
```

### 插件装上了但从不主动说话

正常。它大多数时候选择沉默。想看它怎么想的，去 **设置 → 心跳**：

- 「没有配置发送渠道」→ `channel.wsUrl` / `channel.targetId` 没填
- 「安静时段」→ 当前在 `quietFrom~quietTo` 之间
- 「距上次主动消息还不够久」→ 没到 `minGapMinutes`
- 「主人刚说过话，不打扰」→ `userActiveMinutes` 内有人说话

手动验证一次：设置页点「立即想一次」，或者

```bash
curl -X POST http://127.0.0.1:3080/api/heartbeat/trigger
```

