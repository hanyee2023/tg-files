// 浏览器环境没有 Node 的 os 模块，GramJS 在浏览器构建里会调用 os.type() 等，
// 这里提供一个空实现，并通过 vite.config.js 的 alias 把 import 'os' 指向本文件。

const value = 'Browser';

export function type() { return 'Browser'; }
export function platform() { return 'browser'; }
export function release() { return '0.0.0'; }
export function arch() { return 'browser'; }
export function cpus() { return []; }
export function totalmem() { return 0; }
export function freemem() { return 0; }
export function loadavg() { return [0, 0, 0]; }
export function uptime() { return 0; }
export function hostname() { return 'browser'; }
export function networkInterfaces() { return {}; }
export function userInfo() {
  return { username: 'browser', uid: -1, gid: -1, homedir: '/', shell: null };
}
export function tmpdir() { return '/tmp'; }
export function endianness() { return 'LE'; }
export function version() { return 'v0.0.0'; }
export function constants() { return {}; }

export default {
  type, platform, release, arch, cpus, totalmem, freemem,
  loadavg, uptime, hostname, networkInterfaces, userInfo,
  tmpdir, endianness, version, constants,
};
