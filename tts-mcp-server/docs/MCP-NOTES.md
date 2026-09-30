# MCP 工作原理学习笔记

> 这份笔记基于 [tts-mcp-server](../) 项目的开发过程整理，记录 MCP (Model Context Protocol) 的核心概念与底
> 层机制。

## 目录

1. [MCP 是什么](#1-mcp-是什么)
2. [stdio 通信：三个标准流](#2-stdio-通信三个标准流)
3. [JSON-RPC 协议：消息格式](#3-json-rpc-协议消息格式)
4. [MCP 启动流程：4 步握手](#4-mcp-启动流程4-步握手)
5. [capabilities：能力声明](#5-capabilities能力声明)
6. [MCP handler：两个核心处理器](#6-mcp-handler两个核心处理器)
7. [Node.js 事件驱动基础](#7-nodejs-事件驱动基础)

8. [流式 JSON 解析：跨 chunk 累积](#8-流式-json-解析跨-chunk-累积)
9. [test-mcp.mjs："假 Codex" 客户端](#9-test-mcpmjs假-codex-客户端)
10. [src/index.js 的 4 类输出](#10-srcindexjs-的-4-类输出)
11. [完整调用链：从 spawn 到退出](#11-完整调用链从-spawn-到退出)

---

## 1. MCP 是什么

**MCP (Model Context Protocol)** 是 Anthropic 提出的协议，用于让 LLM（如 Codex）调用外部工具。

核心思想：

- 每个 MCP server 是一个**独立子进程**
- 通过 **JSON-RPC over stdio** 与父进程（Codex）通信
- server 暴露**工具（tools）**给 Codex 调用

三层关系：

```
┌──────────────────────┐
│  Codex (LLM 进程)   │
└──────────┬───────────┘
           │ 启动子进程（stdio）
           ▼
┌──────────────────────┐
│  MCP server (子进程) │
└──────────┬───────────┘
           │ HTTP/WebSocket
           ▼
┌──────────────────────┐
│  外部服务（如 MiniMax） │
└──────────────────────┘
```

---

## 2. stdio 通信：三个标准流

每个进程启动时都有 **3 个标准流**：

| 流 | 全称 | 用途 | 编号 |
|---|---|---|---|
| `stdin` | 标准输入 | 进程**读**数据 | fd 0 |
| `stdout` | 标准输出 | 进程写"正常输出" | fd 1 |
| `stderr` | **标准错误**输出 | 进程写"日志/错误" | fd 2 |

设计上把"正常输出"和"日志/错误"**分开**，原因：消费者（另一个程序）只关心正常输出（协议消息），调试/日志不能污染它。

### MCP 中的关键约束

- **stdout = JSON-RPC 协议专用通道**（给 Codex 解析）
- **stderr = 日志通道**（给人/调试看）

```js
// ✅ 正确：日志走 stderr
console.error('[tts-mcp-server] 已启动...');

// ❌ 错误：日志走 stdout 会破坏协议
console.log('[tts-mcp-server] 已启动...');
```

字节级对比：

```bash
node -e "console.log('日志'); console.log('{\"id\":1}')" 2>/dev/null
# stdout 输出：日志 + {"id":1}  ← 混了！

node -e "console.error('日志'); console.log('{\"id\":1}')" 2>/dev/null
# stdout 输出：{"id":1}  ← 纯净
# stderr 输出：日志  ← 隔离
```

---

## 3. JSON-RPC 协议：消息格式

MCP 使用 **JSON-RPC 2.0**，每个消息是 **单个 JSON 对象 + `\n`**。

### 请求格式

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### 响应格式

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [...]
  }
}
```

### 通知（无响应）

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

### 关键点

- **每条消息以 `\n` 结尾**（newline-delimited JSON）
- **`id` 用于关联请求和响应**
- **错误用 `error` 字段而不是 `result`**

---

## 4. MCP 启动流程：4 步握手

Codex 启动后会与 MCP server 完成 4 步握手：

```
┌─ ① initialize ────────────────────────────┐
│ Codex → server: 我是 Codex，能聊聊吗？    │
│ server → Codex: 我是 tts-mcp-server，    │
│               我支持 tools 能力          │
└───────────────────────────────────────────┘
                       ↓
┌─ ② initialized 通知 ──────────────────────┐
│ Codex → server: 好的，初始化完了         │
│ （无响应，server 静默接受）                │
└───────────────────────────────────────────┘
                       ↓
┌─ ③ tools/list（"摸底"）───────────────────┐
│ Codex → server: 你有哪些工具？            │
│ server → Codex: 我有 speak_text，参数...  │
└───────────────────────────────────────────┘
                       ↓
┌─ ④ tools/call（"点单干活"）───────────────┐
│ Codex → server: 调 speak_text，text=hello │
│ server → Codex: 做好了，文件在 /xxx.mp3   │
└───────────────────────────────────────────┘
```

### 摸底只发生一次

`tools/list` **只在启动时调一次**，结果缓存在 Codex 内存里。后续每次工具调用都是 `tools/call`。

---

## 5. capabilities：能力声明

`new Server(meta, { capabilities: { tools: {} } })` 里的 `capabilities` 是**声明**不是定义。

| 写法 | 含义 | Codex 行为 |
|---|---|---|
| `capabilities: {}` | "我没工具能力" | **不会**调 `tools/list` |
| `capabilities: { tools: {} }` | "我有工具能力，且清单固定" | 启动时**会**调 `tools/list` |
| `capabilities: { tools: { listChanged: true } }` | "我有工具，清单会动态变" | 会调 `tools/list`，并响应 server 的变化通知 |

**餐厅比喻**：

- 不挂"卖菜"招牌 = `capabilities: {}` = 没人知道你来吃饭能点菜
- 挂"卖菜"招牌 = `capabilities: { tools: {} }` = 知道能点菜，进门问菜单（启动时摸底）

---

## 6. MCP handler：两个核心处理器

每个 MCP server 必须注册两个 handler：

### `ListToolsRequestSchema` handler —— 自我介绍（菜单）

```js
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'speak_text',           // 工具名
    description: '把文本转语音...', // 模型根据它判断何时调用
    inputSchema: {                // JSON Schema，Codex 自动校验参数
      type: 'object',
      properties: {
        text: { type: 'string', description: '要朗读的文本' },
        voice_id: { type: 'string', default: 'male-qn-qingse' },
        speed: { type: 'number', minimum: 0.5, maximum: 2.0, default: 1.0 },
        // ...
      },
      required: ['text'],
    },
  }],
}));
```

**`description` 是核心**——LLM 看它决定要不要调这个工具。
**`inputSchema` 不是装饰品**——超出范围的值 Codex 会自动拦截。

### `CallToolRequestSchema` handler —— 真正干活（厨师）

```js
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // 1. 校验工具名
  if (request.params.name !== 'speak_text') throw new Error('未知工具');
  
  // 2. 校验 API Key（防御性）
  if (!API_KEY) throw new Error('API_KEY 未配置');
  
  // 3. 解构参数
  const { text, voice_id } = request.params.arguments ?? {};
  
  // 4. 业务校验（schema 表达不了的）
  if (!text?.trim()) throw new Error('text 必须非空');
  
  // 5. 干活
  const audioBuffer = await synthesizeSpeech(text, { voice_id });
  
  // 6. 落盘（需要绝对路径给 Markdown 音频用）
  const outputPath = generateOutputPath(voice_id);
  writeFileSync(outputPath, audioBuffer);
  
  // 7. 返回 MCP 格式
  return {
    content: [{
      type: 'text',
      text: `✅ 完成\n文件路径：${outputPath}\n请用 Markdown 播放：![audio](${outputPath})`,
    }],
  };
});
```

**返回的 text 里包含"指令"**（如"请用 Markdown 音频语法播放"）——这是给 LLM 的提示词，让它知道下一步该输出什么。

---

## 7. Node.js 事件驱动基础

### `'data'` 事件谁触发

**触发者是 Node 内部的 libuv + EventEmitter**，驱动力是子进程写数据。

触发链路（5 层）：

```
子进程 write(fd=1, data)
    ↓
内核：pipe 缓冲区有数据
    ↓
libuv：epoll/kqueue 监听到 fd 可读
    ↓
Stream 层：把 buffer 切成 chunk
    ↓
EventEmitter：emit('data', chunk)
    ↓
你的回调函数被调用
```

### `on` vs `once`

```js
emitter.on('event', handler)    // 每次都触发
emitter.once('event', handler)  // 只触发一次
```

| API | 类比 |
|---|---|
| `on` | 订报纸，**每天**都送 |
| `once` | 一次性订阅，**只送一次** |

test-mcp.mjs 里的用法：

```js
child.stdout.on('data', ...)      // 持续接收 server 响应
child.stderr.on('data', ...)      // 持续透传日志
child.stderr.once('data', () => { // 只在 server 启动时触发一次
  setTimeout(runProtocol, 100);
});
```

---

## 8. 流式 JSON 解析：跨 chunk 累积

```js
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch (e) {
      console.error('⚠ 非 JSON 行:', line.slice(0, 80));
    }
  }
});
```

三个关键点：

1. **流是异步分批的**：server 不是一次吐完，每次 `data` 事件只来一个 chunk
2. **半个 JSON 可能跨 chunk**：`{"id":1,"r` + `esult":...}`，必须累积
3. **`\n` 是分帧符**：JSON-RPC 协议规定每条消息以 `\n` 结尾

处理过程：

```
chunk1: '{"id":1,"result":...}\n{"id'
   ↓ 找到 \n，切出完整行
parse 成功 → push responses
buf 剩: '{"id'
   ↓ chunk2: ':2,"result":...}\n'
   ↓ 又凑出一行
parse 成功 → push
...循环
```

`try/catch` 兜底异常（半个 JSON、混入乱码），不阻塞后续消息。

---

## 9. test-mcp.mjs："假 Codex" 客户端

`test-mcp.mjs` 是个**用 Node 写的假 Codex**——它扮演 Codex 跟 MCP server 对话。

```js
// 启动子进程 = Codex 拉起 MCP server
const child = spawn('node', ['src/index.js'], { stdio: ['pipe','pipe','pipe'], ... });

// 4 个 send() 调用 = Codex 的 4 个动作
send({ id: 1, method: 'initialize', ... });      // ① 握手
send({ method: 'notifications/initialized' });   // ② 通知初始化完
send({ id: 2, method: 'tools/list', ... }); // ③ 摸底
send({ id: 3, method: 'tools/call', ... });      // ④ 干活
```

与真实 Codex 的区别：

| 对比 | 真实 Codex | test-mcp.mjs |
|---|---|---|
| 拉起子进程 | ✅ | ✅ |
| 发 JSON-RPC 请求 | ✅ | ✅ |
| 收 JSON-RPC 响应 | ✅ | ✅ |
| 决定**何时**调工具 | LLM 判断（看你说啥） | 写死：固定调一次 |

**唯一本质区别**是"什么时候调工具"——LLM 决策 vs 写死。其他完全一致。

---

## 10. src/index.js 的 4 类输出

src/index.js 里一共有 **4 类输出目的地**：

| # | 代码位置 | 输出类型 | 输出给谁 | 通道 |
|---|---|---|---|---|
| 1 | `ws.send` × 3 | WebSocket | **MiniMax 服务端** | 加密 TCP |
| 2 | `writeFileSync` | 文件系统 | **本地磁盘**（写 mp3） | 文件 I/O |
| 3 | `handler return` | MCP 响应 | **Codex** | **stdout**（SDK 序列化） |
| 4 | `console.error` | 日志 | **人/调试者** | **stderr** |

**关键约束**：

- `handler return` 由 SDK 写到 `process.stdout`（注意不是 `console.log`——SDK 直接写底层 fd）
- `console.error` 必须走 stderr，**绝不能**用 `console.log`

---

## 11. 完整调用链：从 spawn 到退出

执行 `node test-mcp.mjs 你好` 后：

```
时间 test-mcp.mjs                              src/index.js (子进程)
────┼──────────────────────────────────────┼──────────────────────────────────
t0  │ Node 加载文件                              │
    │ ├─ import 'node:child_process'            │
t1  │ 检查 MINIMAX_API_KEY                       │
t2  │ console.log('▶ 启动 MCP server 子进程')   │
t3  │ spawn('node', ['src/index.js']) ─────────► Node 启动 src/index.js
    │                                          │ ├─ 读 env，建 Server
    │                                          │ ├─ 注册 ListTools handler
    │                                          │ ├─ 注册 CallTool handler
    │                                          │ ├─ StdioServerTransport
    │                                          │ └─ console.error('已启动...')
t4  │ ◄────────────────────── '已启动' 写到 stderr ──┘
t5  │ child.stderr.once('data') 触发              │
    │ setTimeout(runProtocol, 100)                │
t6  │ runProtocol() 开始                          │
    │                                            │
    │ send(initialize) ───► stdin ───────────────► 收到 initialize
    │ 等待 200ms                                  │ 返回 serverInfo
    │ ◄──────────────────── stdout (id:1) ────────┤
    │                                            │
    │ send(initialized 通知) ► stdin              │
    │                                            │
    │ send(tools/list) ─────► stdin ─────────────► 返回 speak_text 定义
    │ ◄──────────────────── stdout (id:2) ────────┤
    │                                            │
    │ send(tools/call) ─────► stdin ─────────────► 校验参数
    │   {text: '你好'}                            │ 调 MiniMax API
    │                                            │           收 50+ 音频片段
    │ ◄──────────────────────── stdout (id:3) ────┤ 写 mp3 落盘
    │                                            │ 返回 content
    │                                            │
    │ setInterval 轮询到 id=3                     │
    │ 调 finish(callResp)                         │
    │ ├─ child.kill() 杀掉 server 子进程          │
    │ ├─ 打印 4 步响应摘要                        │
    │ └─ process.exit(0) 退出                     │
```

---

## 一句话总结

**MCP = LLM 通过 stdio + JSON-RPC 调用子进程暴露的工具**。Codex 启动时摸一次底（`tools/list`），缓存工具清单；你说"朗读一下"时，LLM 自己决定调 `tools/call`，server 干活后返回文件路径，Codex 把它渲染成 Markdown 音频，桌面应用播放。整个过程就是"一问一答"，核心机制是事件驱动的流式 JSON 解析。
