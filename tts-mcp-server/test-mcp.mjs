#!/usr/bin/env node
// 直接调用 MCP server 的端到端测试脚本
// 用法：MINIMAX_API_KEY=你的key node test-mcp.mjs
//       或者用你已经 export 过的 MINIMAX_API_KEY

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const KEY =
  "sk-cpxxx"; //process.env.MINIMAX_API_KEY;
// if (!KEY) {
//   console.error('❌ 请先 export MINIMAX_API_KEY=你的key');
//   console.error('   或者: MINIMAX_API_KEY=sk-cp-xxx node test-mcp.mjs');
//   process.exit(1);
// }

console.log("▶ 启动 MCP server 子进程...");
const child = spawn("node", ["src/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MINIMAX_API_KEY: KEY },
});

let buf = "";
const responses = []; // 收集所有 JSON-RPC 响应

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch (e) {
      console.error("⚠ 非 JSON 行:", line.slice(0, 80));
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

// 等待 server 启动，stderr 第一行 "已启动" 就是信号
child.stderr.once("data", () => {
  setTimeout(runProtocol, 100);
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

async function runProtocol() {
  // 1) initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-mcp", version: "1.0.0" },
    },
  });
  await sleep(200);

  // 2) initialized 通知
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(200);

  // 3) tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await sleep(300);

  // 4) tools/call speak_text
  const testText = process.argv[2] || "这是一段 MCP 单独调用测试。";
  console.log(`\n▶ 调用 speak_text，文本: "${testText}"`);
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "speak_text",
      arguments: { text: testText, voice_id: "male-qn-qingse" },
    },
  });

  // 等待 tools/call 响应（id=3）到达后退出
  const start = Date.now();
  const timer = setInterval(() => {
    const callResp = responses.find((r) => r.id === 3);
    if (callResp) {
      clearInterval(timer);
      finish(callResp);
    }
    if (Date.now() - start > 30000) {
      clearInterval(timer);
      console.error("❌ 超时（30s）");
      child.kill();
      process.exit(1);
    }
  }, 100);
}

function finish(callResp) {
  child.kill();

  console.log("\n=== 协议响应汇总 ===");
  for (const r of responses) {
    if (r.id === 1) {
      console.log(
        `initialize     → serverInfo: ${r.result?.serverInfo?.name} v${r.result?.serverInfo?.version}`,
      );
    } else if (r.id === 2) {
      const tools = r.result?.tools?.map((t) => t.name).join(", ");
      console.log(
        `tools/list     → ${r.result?.tools?.length} 个工具: ${tools}`,
      );
    } else if (r.id === 3) {
      if (r.error) {
        console.log(
          `tools/call     → ❌ 错误 [${r.error.code}]: ${r.error.message}`,
        );
        process.exit(1);
      }
      const text = r.result?.content?.[0]?.text || "";
      const pathMatch = text.match(/文件路径：(.+)/);
      const sizeMatch = text.match(/文件大小：(\d+) 字节/);
      if (pathMatch && sizeMatch) {
        const filePath = pathMatch[1].trim();
        const size = parseInt(sizeMatch[1]);
        const exists = existsSync(filePath);
        const actualSize = exists ? statSync(filePath).size : 0;
        console.log(`tools/call     → ✅ 成功`);
        console.log(`  路径         : ${filePath}`);
        console.log(`  报告大小     : ${size} 字节`);
        console.log(
          `  实际大小     : ${actualSize} 字节 ${exists ? "✓" : "✗ 文件不存在"}`,
        );
        console.log(`\n🎉 全部通过！打开文件播放：`);
        console.log(`   open "${filePath}"`);
      } else {
        console.log(`tools/call     → 响应: ${text}`);
      }
    }
  }
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
