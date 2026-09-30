#!/usr/bin/env node
// ============================================================================
// tts-mcp-server
// ----------------------------------------------------------------------------
// 职责：把 MiniMax T2A 语音合成 API 封装成一个 Codex 可调用的 MCP 工具。
//
// 工作链路（自上而下读这份文件即可）：
//   1. Codex 启动本进程（stdin/stdout 被 Codex 接管），这是 stdio transport
//   2. Codex 走 JSON-RPC 协议发请求；本进程用 @modelcontextprotocol/sdk 解析
//   3. 收到 tools/call(speak_text) 后，调下面的 synthesizeSpeech() 合成语音
//   4. 把合成的 mp3 写到 ~/.codex/tts_cache/，把绝对路径返回给 Codex
//   5. Codex 拿到路径，用 Markdown 音频语法 ![audio](...)\npl自动播放
//
// 与 MiniMax 的协议（实测整理出来的，文档里没完整列出来）：
//   WebSocket: wss://api-bj.minimaxi.com/ws/v1/t2a_v2
//   客户端 → task_start                       → 服务端回 connected_success + task_started
//   客户端 → task_continue{ text }            → 服务端多次回 task_continued{ data:{audio:hex }, is_final }
//   客户端 → task_finish                      → 服务端回 task_finished
//   音频字段：msg.data.audio（hex 字符串），解码后用 Buffer.concat 合成完整文件
// ============================================================================

// ----------------------------------------------------------------------------
// 依赖导入
// ----------------------------------------------------------------------------
// MCP SDK 提供的 Server 类：负责"我有哪些工具 / 怎么处理调用"，与传输层解耦
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// MCP SDK 的 stdio transport：负责"通过 stdin/stdout 跟 Codex 通信"
//   另一个常见选择是 StreamableHTTPServerTransport（走 HTTP）
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// MCP 协议的两个消息 Schema（Zod 定义）：
//   - ListToolsRequestSchema：客户端问"你有哪些工具"
//   - CallToolRequestSchema：客户端说"我要调用某个工具"
// 用 setRequestHandler(Schema, handler) 注册处理函数
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// ws 是 Node.js 生态最常用的 WebSocket 客户端；MCP SDK 不带，需要单独装
// 用来跟 MiniMax 的 T2A 接口通信（它是 WebSocket，不是 HTTP）
import WebSocket from 'ws';

// Node.js 内置模块，处理文件落盘和路径拼接
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// 配置区：所有"可能会改"的值集中在这里，方便维护
// ============================================================================

// API Key 强制走环境变量——绝不能硬编码到源码或 config.toml 明文
// Codex 启动这个 MCP 子进程时会把 env 注入（见 ~/.codex/config.toml 的 [mcp_servers.tts.env]）
const API_KEY = process.env.MINIMAX_API_KEY;

// MiniMax T2A WebSocket 端点
// 文档默认是 wss://api.minimax.cn/ws/v1/t2a_v2；这里用华北加速的 api-bj.*（首包延迟更低）
const WS_URL = 'wss://api-bj.minimaxi.com/ws/v1/t2a_v2';

// 默认音色：青涩青年男声，中文场景自然且不容易"机器感"
// 完整音色列表：https://platform.minimax.cn/docs/guides/speech-t2a-websocket
const DEFAULT_VOICE = 'male-qn-qingse';

// 默认模型：speech-2.8-hd 是最新高清版（重渲染自然度）
// 如果想要更快可改成 speech-2.8-turbo（速度优先，质量略低）
const DEFAULT_MODEL = 'speech-2.8-hd';

// 输出目录：用户家目录下的 .codex/tts_cache/
// 用 homedir() 而不是硬编码 /Users/username，跨平台一致
// 文件名带 ISO 时间戳，多次调用不会覆盖
const CACHE_DIR = join(homedir(), '.codex', 'tts_cache');

// 单次合成的最长等待时间（毫秒）。实测每千字约 8 秒，
// 所以 60 秒大约能处理 7000-7500 字的中文；超过会被超时杀掉
// 如果要支持 10000 字上限（文档允许），改成 180_000（3 分钟）更稳妥
const REQUEST_TIMEOUT_MS = 60_000;

// ============================================================================
// 工具函数区
// ============================================================================

/**
 * 生成输出文件路径，并保证目录存在。
 *
 * @param {string} voiceId - 音色 ID，会做"文件名安全"清洗
 * @returns {string} 完整的 mp3 文件绝对路径
 *
 * 文件名格式：tts_<safeVoiceId>_<ISO 时间戳>.mp3
 *   例如：tts_male-qn-qingse_2026-09-30T03-20-17-373Z.mp3
 *
 * 时间戳精确到毫秒 + ISO 格式里把 `:` 和 `.` 替换成 `-`，
 * 这样多次调用不会撞名，文件名也合法。
 */
function generateOutputPath(voiceId) {
  // 幂等创建目录：父目录不存在就建，存在就跳过（recursive: true 不会报错）
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  // 清洗音色 ID：只保留字母/数字/下划线/连字符，其他换成下划线
  // （防 voiceId 里夹中文或特殊字符导致文件名非法）
  const safeVoice = (voiceId || DEFAULT_VOICE).replace(/[^a-zA-Z0-9_-]/g, '_');

  // ISO 时间戳，例如 2026-09-30T03:20:17.373Z
  // 把冒号和点替换成横线，得到 2026-09-30T03-20-17-373Z（文件名合法）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  return join(CACHE_DIR, `tts_${safeVoice}_${stamp}.mp3`);
}

/**
 * 核心业务函数：调 MiniMax T2A 把一段文本合成成 mp3 音频。
 *
 * @param {string} text - 要朗读的文本（中文/英文均可）
 * @param {object} [options] - 可选参数
 * @param {string} [options.voice_id='male-qn-qingse'] - 音色 ID
 * @param {number} [options.speed=1.0] - 语速 0.5-2.0
 * @param {number} [options.vol=1.0] - 音量 0-10
 * @param {number} [options.pitch=0] - 音调 -12 到 12
 * @param {string} [options.model='speech-2.8-hd'] - 模型
 * @returns {Promise<Buffer>} 完整 mp3 文件的 Buffer
 *
 * 实现要点：
 *   - WebSocket 是事件驱动，但 MCP 调用方希望 "await 拿到 Buffer 或 throw"
 *     所以包成 Promise，用 settled 标志防多次触发
 *   - 服务端是流式返回音频，每段 ~4KB，需要拼起来才是完整 mp3
 *   - 必须有超时兜底，否则服务卡死会一直挂着
 */
function synthesizeSpeech(text, options = {}) {
  // 解构参数 + 默认值：调用方可以只传 text，其他都走默认
  const {
    voice_id = DEFAULT_VOICE,
    speed = 1.0,
    vol = 1.0,
    pitch = 0,
    model = DEFAULT_MODEL,
  } = options;

  // 包成 Promise：把"事件驱动"包装成"async/await 友好的返回值"
  return new Promise((resolve, reject) => {
    // 建立 WebSocket 连接，Authorization header 走 Bearer Token 鉴权
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    // 收集服务端发来的所有音频片段，最后拼接成完整 mp3
    const audioChunks = [];

    // settled 标志：Promise 只能 resolve/reject 一次。
    // WebSocket 的 message/error/close 三个事件都可能先到达，
    // 不加这个标志可能重复触发，导致 UnhandledPromiseRejection
    let settled = false;

    // 统一的"收尾函数"：保证 resolve/reject 互斥，且清理资源
    const finish = (fn, arg) => {
      if (settled) return;       // 已经结束过，直接忽略
      settled = true;
      clearTimeout(timer);        // 清掉超时定时器
      try { ws.close(); } catch {} // 主动关 WebSocket（即使已经关了也不抛）
      fn(arg);                    // 真正调用 resolve 或 reject
    };

    // 超时保险：60 秒还没收到 task_finished 就当作失败
    const timer = setTimeout(() => {
      finish(reject, new Error(`MiniMax T2A 请求超时（${REQUEST_TIMEOUT_MS}ms）`));
    }, REQUEST_TIMEOUT_MS);

    // ------------------------------------------------------------------
    // 事件 1：open —— 连接建立成功，立即发任务启动消息
    // ------------------------------------------------------------------
    ws.on('open', () => {
      // 第 1 步：声明任务参数（模型、音色、音频规格）
      // 注意 audio_setting.channel 必须传（虽然直觉上不重要，文档要求）
      ws.send(JSON.stringify({
        event: 'task_start',
        model,
        voice_setting: {
          voice_id,
          speed,
          vol,
          pitch,
          english_normalization: false, // 中文为主，关掉英文规范化
        },
        audio_setting: {
          sample_rate: 32000,           // 32 kHz，CD 音质一半但文件小
          bitrate: 128000,                // 128 kbps
          format: 'mp3',                 // 输出格式
          channel: 1,                    // 单声道
        },
        stream: true,                   // 开启流式返回（必须，否则收不到分段音频）
      }));

      // 第 2 步：发送要朗读的文本
      // 协议允许多次 task_continue 做"分块流式输入"，适合对接大模型逐字输出；
      // 这里一次性发完，简单够用。超长文本可以改成按句子多次发送。
      ws.send(JSON.stringify({ event: 'task_continue', text }));

      // 第 3 步：通知服务端"文本发完了，可以合成并返回了"
      ws.send(JSON.stringify({ event: 'task_finish' }));
    });

    // ------------------------------------------------------------------
    // 事件 2：message —— 接收服务端发来的所有消息
    // 服务端会发：connected_success / task_started / task_continued*N / task_finished / task_failed
    // ------------------------------------------------------------------
    ws.on('message', (raw) => {
      // 尝试解析 JSON；如果不是 JSON 帧（极少见），直接忽略
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // 路径 A：收到音频片段（task_continued 事件里携带）
      if (msg.data && msg.data.audio) {
        // 服务端的 audio 字段是 hex 编码字符串，需要解码成二进制 Buffer
        audioChunks.push(Buffer.from(msg.data.audio, 'hex'));
        return;
      }

      // 路径 B：服务端通知"全部音频发完了"，合并所有片段 → 成功返回
      if (msg.event === 'task_finished') {
        finish(resolve, Buffer.concat(audioChunks));
        return;
      }

      // 路径 C：业务错误（task_failed 等）只在终结性事件时上报
      // task_continued 里的中间消息不算终结（可能含 is_final=false）
      if (
        msg.base_resp &&
        msg.base_resp.status_code !== 0 &&
        msg.event !== 'task_continued'
      ) {
        finish(reject, new Error(
          `MiniMax 错误 [${msg.base_resp.status_code}]: ${msg.base_resp.status_msg}`
        ));
      }
    });

    // ------------------------------------------------------------------
    // 事件 3：error —— 底层连接错误（DNS 失败、TLS 失败、被拒等）
    // ------------------------------------------------------------------
    ws.on('error', (err) => {
      finish(reject, err);
    });

    // ------------------------------------------------------------------
    // 事件 4：close —— 连接关闭（包括正常关闭和异常关闭）
    // ------------------------------------------------------------------
    ws.on('close', () => {
      // 如果还没 settled 就被关了，说明出问题了（正常流程是收到 task_finished 后由 finish() 主动关）
      if (!settled) {
        finish(reject, new Error('WebSocket 提前关闭，未收到 task_finished'));
      }
    });
  });
}

// ============================================================================
// MCP Server 注册区
// ============================================================================

// 创建一个 MCP Server 实例
//   第 1 个参数：自报家门（name + version），Codex 会用来显示
//   第 2 个参数：声明能力（capabilities）。这里只暴露 tools，不暴露 resources/prompts
const server = new Server(
  { name: 'tts-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ----------------------------------------------------------------------------
// 注册"列出工具"的处理器
// Codex 启动时会问"你有哪些工具？"——这个 handler 回答这个问题
// 返回的 schema 是 JSON Schema 标准，Codex 用它来做参数校验
// ----------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      // 工具名：调用时用这个名字（必须是合法 JS 标识符）
      name: 'speak_text',

      // 描述：Codex 决定"要不要调用这个工具"时主要看这个字段
      // 写得越清晰，Codex 越知道在什么场景下用它
      description:
        '把一段文本通过 MiniMax T2A 合成语音，保存为 mp3 文件并返回绝对路径。' +
        '返回路径后，调用方（Codex）应当用 Markdown 音频语法 ![audio](/绝对路径.mp3) 触发自动播放。' +
        '只有明确需要朗读时才调用，避免不必要的 API 消耗。',

      // inputSchema 是 JSON Schema 子集，定义参数的形状
      // Codex 在调用前会自动校验参数类型和范围
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要朗读的文本内容（中文/英文均可）',
          },
          voice_id: {
            type: 'string',
            description: 'MiniMax 音色 ID，默认 male-qn-qingse（青涩男声）。常用备选：female-shaonv（少女音）、male-qn-jingying（精英男声）、presenter_male（主持人男声）',
            default: DEFAULT_VOICE,  // 这里直接用上面的常量，确保 schema 和实现一致
          },
          speed: {
            type: 'number',
            description: '语速倍率，0.5-2.0，1.0 为正常语速',
            minimum: 0.5,
            maximum: 2.0,
            default: 1.0,
          },
          vol: {
            type: 'number',
            description: '音量，0-10，1.0 为正常音量',
            minimum: 0,
            maximum: 10,
            default: 1.0,
          },
          pitch: {
            type: 'number',
            description: '音调调整，-12 到 12，0 为原调',
            minimum: -12,
            maximum: 12,
            default: 0,
          },
        },
        // 必填字段列表（其余都是可选）
        required: ['text'],
      },
    },
  ],
}));

// ----------------------------------------------------------------------------
// 注册"调用工具"的处理器 —— 这是真正干活的入口
// Codex 决定调用 speak_text 后，会发一个 tools/call 请求进来
// ----------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // ---------- 1. 校验工具名 ----------
  // 理论上 schema 已经限定只能调 speak_text，这里做个防御
  if (request.params.name !== 'speak_text') {
    throw new Error(`未知工具: ${request.params.name}`);
  }

  // ---------- 2. 校验 API Key ----------
  // Codex 启动本进程时应该已经注入 env。这里再校验是为了给清晰的错误信息
  // 如果没配 key，抛错而不是默默调用（避免 401 错误难调试）
  if (!API_KEY) {
    throw new Error(
      '环境变量 MINIMAX_API_KEY 未配置。' +
      '请在 shell 里执行 export MINIMAX_API_KEY=你的key 后再启动本 MCP server。'
    );
  }

  // ---------- 3. 解构参数 ----------
  // ?? {} 防止 Codex 没传 arguments（极端情况）
  const args = request.params.arguments ?? {};
  const { text, voice_id, speed, vol, pitch } = args;

  // ---------- 4. 业务参数校验 ----------
  // schema 已经校验过类型，这里再校验"非空字符串"——schema 没法表达 trim 后的非空
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('参数 text 必须是非空字符串');
  }

  // ---------- 5. 调核心函数合成语音 ----------
  // 整个流程最耗时的一步（5-15 秒）
  const audioBuffer = await synthesizeSpeech(text, {
    voice_id, speed, vol, pitch,
  });

  // ---------- 6. 防御性检查 ----------
  // 万一 MiniMax 返回了空音频（比如文本全是空格或全是不支持的字符），明确报错
  if (audioBuffer.length === 0) {
    throw new Error('MiniMax 返回了空音频，请检查文本或参数');
  }

  // ---------- 7. 落盘 ----------
  // 为什么落盘而不是直接返回 Buffer：Codex 需要一个绝对路径用 Markdown 语法播放，
  // 直接返回 Buffer（base64）也能播但要嵌入 data URI，桌面应用兼容性差
  const outputPath = generateOutputPath(voice_id);
  writeFileSync(outputPath, audioBuffer);

  // ---------- 8. 返回 MCP 标准格式 ----------
  // MCP 协议：handler 返回值会被 SDK 包装成 JSON-RPC 响应发给 Codex
  // content 数组里可以有多个元素（text/image/audio 等），这里只用一个 text
  // text 里把路径告诉 Codex，并"提醒"它用 Markdown 音频语法触发播放
  return {
    content: [
      {
        type: 'text',
        text:
          `✅ 语音合成完成\n` +
          `文件路径：${outputPath}\n` +
          `文件大小：${audioBuffer.length} 字节\n` +
          `请用 Markdown 音频语法播放：![audio](${outputPath})`,
      },
    ],
  };
});

// ============================================================================
// 启动 stdio transport —— 让 server 开始监听 stdin
// ============================================================================

// 创建一个 stdio transport：底层绑定 process.stdin 和 process.stdout
// （注意：不是 process.stderr！stderr 是给日志用的，不会污染协议）
const transport = new StdioServerTransport();

// 把 server 挂到 transport 上，开始循环监听 stdin 的 JSON-RPC 消息
// await 是因为 connect 是异步的（内部要注册事件监听器）
await server.connect(transport);

// 启动后输出一行日志到 stderr —— 走 console.error 而不是 console.log，
// 因为 stdout 是 MCP 通信通道，任何日志写在那里都会破坏 JSON-RPC 解析
// （Codex 会读到非 JSON 行就报错）
console.error('[tts-mcp-server] 已启动，等待 Codex 调用 speak_text...');
