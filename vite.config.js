import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'url';

// GramJS 浏览器构建会调用 os.type() 等设备信息，浏览器里没有 Node 的 os 模块，
// 这里把 import 'os' 重定向到一个空实现桩，避免构建/运行报 Cannot find module 'os'
const osStub = fileURLToPath(new URL('./src/stubs/os.js', import.meta.url));

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      os: osStub,
    },
  },
  build: {
    outDir: 'dist',
  },
  define: {
    global: 'globalThis',
  },
});
