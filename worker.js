/**
 * Telegram MTProto WebSocket/HTTP Proxy Worker
 * Version: v19
 * 
 * 基于 Flowseal/tg-ws-proxy 的验证可用方案
 * https://github.com/Flowseal/tg-ws-proxy/blob/main/docs/RU/CfWorker.md
 * 
 * 核心原理：
 * - 浏览器 ↔ Worker: WSS (TLS，由 Cloudflare 处理)
 * - Worker ↔ Telegram: 原始 TCP 443 (无 TLS，MTProto 自带加密)
 * - 不需要 WebSocket 帧编解码，Cloudflare WebSocketPair 自动处理
 * - 不需要手动 TLS，MTProto 协议自带加密层
 * 
 * 数据流：
 * 1. 浏览器发送 WebSocket 消息 (含 MTProto 加密数据)
 * 2. Worker 提取消息的原始字节，直接写入 TCP
 * 3. Telegram 收到原始 MTProto 数据，处理并返回
 * 4. Worker 从 TCP 读取响应字节，作为 WebSocket 消息发给浏览器
 * 5. GramJS 解密并处理 MTProto 响应
 */

import { connect } from "cloudflare:sockets";

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data && typeof data.arrayBuffer === "function") {
    return data.arrayBuffer().then((ab) => new Uint8Array(ab));
  }
  return new Uint8Array();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        version: "v19",
        service: "Telegram WS Proxy (raw TCP, Flowseal approach)",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 从路径提取目标: /vesta.web.telegram.org/apiws → host=vesta.web.telegram.org, path=/apiws
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 1) {
      return new Response("Bad Request", { status: 400 });
    }

    const targetHost = parts[0];
    const targetPath = "/" + parts.slice(1).join("/");

    // 安全检查：只允许 telegram.org 域名
    const allowedPattern = /^[a-z0-9\-]+\.(?:web\.)?telegram\.org$/i;
    if (!allowedPattern.test(targetHost)) {
      return new Response("Forbidden", { status: 403 });
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";

    // ===== HTTP 代理 =====
    if (upgradeHeader.toLowerCase() !== "websocket") {
      const targetUrl = `https://${targetHost}${targetPath}${url.search}`;
      try {
        const headers = new Headers(request.headers);
        headers.set("Host", targetHost);
        headers.delete("cf-connecting-ip");
        headers.delete("cf-ipcountry");
        headers.delete("cf-ray");
        headers.delete("cf-visitor");
        headers.delete("cf-worker");

        const response = await fetch(targetUrl, {
          method: request.method,
          headers: headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
          redirect: "follow",
        });

        const respHeaders = new Headers(response.headers);
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
        });
      } catch (err) {
        return new Response(`Proxy error: ${err.message}`, { status: 502 });
      }
    }

    // ===== WebSocket 代理 (Flowseal 方案) =====
    // 浏览器 → Worker: WebSocket (Cloudflare 处理 WSS/TLS)
    // Worker → Telegram: 原始 TCP 443 (MTProto 自带加密，不需要 TLS)
    console.log(`[WS] ${url.pathname} -> TCP ${targetHost}:443`);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // 创建到 Telegram 的原始 TCP 连接 (无 TLS)
    // MTProto 协议有自己的加密层，不需要传输层 TLS
    const socket = connect({ hostname: targetHost, port: 443 });
    const tcpReader = socket.readable.getReader();
    const tcpWriter = socket.writable.getWriter();

    // 浏览器 → Telegram: WebSocket 消息 → 原始字节 → TCP
    server.addEventListener("message", async (event) => {
      try {
        const bytes = await toBytes(event.data);
        await tcpWriter.write(bytes);
      } catch (e) {
        console.error("[WS] tcp write error:", e.message);
        try { server.close(1011, "tcp write failed"); } catch {}
      }
    });

    server.addEventListener("close", async () => {
      console.log("[WS] client closed");
      try { await tcpWriter.close(); } catch {}
      try { socket.close(); } catch {}
    });

    server.addEventListener("error", () => {
      console.error("[WS] client error");
      try { socket.close(); } catch {}
    });

    // Telegram → 浏览器: TCP 数据 → WebSocket 消息
    (async () => {
      try {
        while (true) {
          const { value, done } = await tcpReader.read();
          if (done) break;
          if (value) {
            try {
              server.send(value);
            } catch (e) {
              console.error("[WS] ws send error:", e.message);
              break;
            }
          }
        }
      } catch (e) {
        console.error("[WS] tcp read error:", e.message);
      } finally {
        console.log("[WS] tcp stream ended");
        try { server.close(); } catch {}
        try { tcpReader.releaseLock(); } catch {}
        try { socket.close(); } catch {}
      }
    })();

    return new Response(null, { status: 101, webSocket: client });
  }
};
