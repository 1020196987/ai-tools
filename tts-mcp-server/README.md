# tts-mcp-server

把 MiniMax T2A 语音合成封装成 Codex 可调用的 MCP 工具。

## 它做什么

暴露一个 `speak_text` 工具：传入文本，返回 mp3 文件的绝对路径。Codex 拿到路径后可以用 Markdown 音频语法 `![audio](/绝对路径.mp3)` 自动播放。

**只在 Codex 明确需要朗读的时候手动调用**，避免不必要的 API 消耗。

## 项目结构

```
tts-mcp-server/
├── src/index.js        # MCP server 主程序（单文件，258 行）
├── package.json
├── .env.example        # API key 配置模板
├── .gitignore
├── node_modules/       # 依赖（@modelcontextprotocol/sdk + ws）
└── README.md
```

## 一、安装依赖

```bash
cd tts-mcp-server
npm install
```

需要 Node.js >= 18。

## 二、配置 API Key

**绝对不要把 key 写进代码里**。两种方式二选一：

### 方式 A：写到 shell 配置（推荐）

把下面这行加到 `~/.zshrc` 或 `~/.bashrc`：

```bash
export MINIMAX_API_KEY=sk-cp-你的真实key
```

然后 `source ~/.zshrc` 让它生效。

### 方式 B：直接 export 当前会话

```bash
export MINIMAX_API_KEY=sk-cp-你的真实key
```

启动 server 前必须先 export。

## 三、注册到 Codex

在 Codex 的 MCP 配置文件里加一条：

```json
{
  "mcpServers": {
    "tts": {
      "command": "node",
      "args": ["/xxx/tts-mcp-server/src/index.js"],
      "env": {
        "MINIMAX_API_KEY": "sk-cp-你的真实key"
      }
    }
  }
}
```

`env` 字段是兜底用——shell 里已经 export 过的话这里不写也行；没 export 写上更稳。

## 四、调用方式

在 Codex 对话里直接说"朗读一下"或者"读给我听"，Codex 会自动调 `speak_text`：

```
工具调用：speak_text
  text: "你好，这是一段测试语音。"
  voice_id: "male-qn-qingse"   // 可选
  speed: 1.0                    // 可选
```

工具返回后，Codex 会在回复里插入 Markdown 音频：

![audio](/xxx/.codex/tts_cache/tts_male-qn-qingse_xxx.mp3)

桌面端会自动播放。

## 五、常用音色

| voice_id | 描述 |
|---|---|
| `male-qn-qingse` | 青涩青年男声（默认） |
| `male-qn-jingying` | 精英男声 |
| `female-shaonv` | 少女音 |
| `presenter_male` | 主持人男声 |
| `presenter_female` | 主持人女声 |

完整音色列表见 [MiniMax 官方文档](https://platform.minimax.cn/docs/guides/speech-t2a-websocket)。

## 六、协议细节（开发参考）

- **WebSocket 端点**：`wss://api-bj.minimaxi.com/ws/v1/t2a_v2`（按 [MiniMax 官方文档](https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket) 的华北加速推荐）
- **事件流**：
  - 客户端发 `task_start` → 服务端回 `connected_success` + `task_started`
  - 客户端发 `task_continue{text}` → 服务端多次回 `task_continued{data:{audio:'hex'}}`
  - 客户端发 `task_finish` → 服务端回 `task_finished` → 关闭
- **音频提取**：`msg.data.audio` 是 hex 编码字符串，`Buffer.from(hex, 'hex')` 解码后拼接

## 七、常见问题

**Q: Codex 看不到工具？**
A: 检查 `args` 路径是否正确；终端手动跑一遍 `node src/index.js` 看是否报错。

**Q: 报错 "环境变量 MINIMAX_API_KEY 未配置"？**
A: shell 里 export 之后需要重启 Codex 才会生效。

**Q: 想换模型？**
A: 改 `src/index.js` 顶部 `DEFAULT_MODEL`，可选 `speech-2.8-hd`（高质）或 `speech-2.8-turbo`（更快）。

**Q: 想换音色默认值？**
A: 改 `DEFAULT_VOICE` 常量。

**Q: 想换输出目录？**
A: 改 `CACHE_DIR` 常量。文件名带时间戳，不会覆盖。

## 八、学习资料

如果想搞懂底层的 MCP 工作机制（stdio、JSON-RPC、事件驱动、handler 解析），看 [docs/MCP-NOTES.md](docs/MCP-NOTES.md)，是我开发过程中整理的一份学习笔记。
