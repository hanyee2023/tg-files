/**
 * Telegram MTProto WebSocket/HTTP Proxy Worker
 * Version: v13
 * 
 * 策略：fetch() + Upgrade 创建到 Telegram 的出站 WebSocket（自带 TLS）
 * 关键改进：
 * 1. 不设置 Host/Origin 头（让 Cloudflare 自动处理）
 * 2. 设置 Sec-WebSocket-Protocol: binary（Telegram 要求）
 * 3. ctx.waitUntil() 保持消息泵存活
 * 4. 错误信息通过 WebSocket 发回客户端便于调试
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        version: "v13",
        service: "Telegram WS Proxy (fetch+upgrade)",
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

    // 从路径提取目标
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 1) {
      return new Response("Bad Request", { status: 400 });
    }

    const targetHost = parts[0];
    const targetPath = "/" + parts.slice(1).join("/");

    // 安全检查
    const allowedPattern = /^[a-z0-9\-]+\.(?:web\.)?telegram\.org$/i;
    if (!allowedPattern.test(targetHost)) {
      return new Response("Forbidden", { status: 403 });
    }

    // ===== WebSocket 代理 =====
    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (upgradeHeader.toLowerCase() === "websocket") {
      // 用 https:// 而非 wss://（Cloudflare fetch 要求 https://）
      const targetUrl = `https://${targetHost}${targetPath}`;
      console.log(`[WS] ${url.pathname} -> ${targetUrl}`);

      try {
        // 用 fetch + Upgrade header 创建出站 WebSocket
        // Cloudflare 自动处理 TLS 和 WebSocket 握手
        // 只设置 Telegram 需要的最少头，不设 Host/Origin（让 CF 处理）
        const upstreamResp = await fetch(targetUrl, {
          headers: {
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Protocol": "binary",
          },
        });

        const upstream = upstreamResp.webSocket;
        if (!upstream) {
          console.error("[WS] upstream no webSocket, status:", upstreamResp.status);
          const [clientSide, workerSide] = new WebSocketPair();
          workerSide.accept();
          const errBody = await upstreamResp.text().catch(() => "");
          try {
            workerSide.send(JSON.stringify({ 
              error: "upstream_failed", 
              status: upstreamResp.status, 
              body: errBody.substring(0, 500) 
            }));
          } catch (e) {}
          try { workerSide.close(1011, "upstream failed"); } catch (e) {}
          return new Response(null, { status: 101, webSocket: clientSide });
        }

        // 创建客户端侧 WebSocket
        const [clientSide, workerSide] = new WebSocketPair();
        workerSide.accept();
        upstream.accept();

        let workerClosed = false;
        let upstreamClosed = false;

        const cleanup = () => {
          if (!workerClosed) {
            try { workerSide.close(); } catch (e) {}
            workerClosed = true;
          }
          if (!upstreamClosed) {
            try { upstream.close(); } catch (e) {}
            upstreamClosed = true;
          }
        };

        // 客户端 -> 上游
        workerSide.addEventListener("message", (event) => {
          try {
            upstream.send(event.data);
          } catch (e) {
            console.error("[WS] c->u error", e.message);
          }
        });

        // 上游 -> 客户端
        upstream.addEventListener("message", (event) => {
          try {
            workerSide.send(event.data);
          } catch (e) {
            console.error("[WS] u->c error", e.message);
          }
        });

        // 关闭处理
        workerSide.addEventListener("close", () => {
          console.log("[WS] client closed");
          cleanup();
        });

        upstream.addEventListener("close", () => {
          console.log("[WS] upstream closed");
          cleanup();
        });

        workerSide.addEventListener("error", () => {
          console.error("[WS] client error");
          cleanup();
        });

        upstream.addEventListener("error", () => {
          console.error("[WS] upstream error");
          cleanup();
        });

        // 用 ctx.waitUntil 保持 Worker 存活
        // 这比 new Promise(() => {}) 更优雅
        const keepAlive = new Promise((resolve) => {
          const check = () => {
            if (workerClosed && upstreamClosed) resolve();
            else setTimeout(check, 1000);
          };
          setTimeout(check, 1000);
        });
        ctx.waitUntil(keepAlive);

        return new Response(null, {
          status: 101,
          webSocket: clientSide,
        });
      } catch (err) {
        console.error("[WS] setup error", err.message, err.stack);
        const [clientSide, workerSide] = new WebSocketPair();
        workerSide.accept();
        try {
          workerSide.send(JSON.stringify({ 
            error: "connection_failed", 
            message: err.message,
            stack: err.stack ? err.stack.substring(0, 500) : "",
          }));
        } catch (e) {}
        try { workerSide.close(1011, err.message); } catch (e) {}
        return new Response(null, { status: 101, webSocket: clientSide });
      }
    }

    // ===== HTTP 代理 =====
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
};
