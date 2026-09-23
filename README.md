# Tg-files

一个基于 Telegram API 的网页端文件浏览 / 网盘工具。可以把任意 Telegram 频道当作「网盘」使用：在网页里浏览、搜索、预览、上传、下载其中的媒体与文件，支持手机号 + 验证码的网页端登录。

> 仅供个人在合规前提下管理自己拥有或有权访问的内容。
<img width="195" height="400" alt="屏幕截图_23-9-2026_14157_tele reader cc cd" src="https://github.com/user-attachments/assets/36aa6b8f-7afa-4b53-8d4d-1f2f6a88a3f9" />


## 功能特性

- 对话 / 频道浏览，按天显示日期分隔（`xxxx年xx月xx日`）
- **网盘模式**：选择一个频道作为网盘，以列表方式浏览文件，支持缩略图、图片 / 视频预览
- 媒体查看器：图片、视频（流式播放，边下边播），可左右切换
- 上传 / 下载（走浏览器原生下载管理器，带实时进度条）
- 外观：浅色 / 深色（夜间模式）、多种主题色、自定义聊天背景（纯色或上传图片）
- 响应式布局，适配手机与桌面
- 设置内「错误报告」：收集运行错误（带时间戳），不再在主页弹出阻塞式红条

## 技术栈

- 前端：原生 JavaScript（无框架）
- Telegram 客户端：[gramJS](https://github.com/gramjs/gramjs)（`telegram`）
- 构建：[Vite](https://vitejs.dev/) + `vite-plugin-node-polyfills`
- 部署：Cloudflare Pages（源码构建）

## 配置

通过构建期环境变量注入：

| 变量名 | 说明 |
|--------|------|
| `VITE_API_ID` | Telegram API ID |
| `VITE_API_HASH` | Telegram API Hash |
| `VITE_PROXY_DOMAIN` | 代理域名（用于访问 Telegram，留空则直连） |

**回退机制**：若构建时未注入，应用在登录页会提供输入框，手动填写一次后会保存到浏览器本地（`localStorage`），无需重新打包。

> ⚠️ 千万不要把真实的 `API_ID` / `API_HASH` / 代理地址 / 会话字符串提交进公开仓库。

## 本地开发

```bash
npm install
npm run build        # 产物输出到 dist/
# 本地预览：用任意静态服务器托管 dist/，例如：npx serve dist
```

## 部署（Cloudflare Pages）

1. 将本仓库推送到 GitHub。
2. 在 Cloudflare Pages 连接该仓库，构建命令填 `npm run build`，输出目录填 `dist`。
3. 在 Cloudflare Pages 的「环境变量」中设置 `VITE_API_ID` / `VITE_API_HASH` / `VITE_PROXY_DOMAIN`。
4. 推送后自动构建部署。

> 注意：务必使用「源码 + 环境变量」方式部署，**不要**直接上传未带环境变量编译的 `dist`，否则代理 / 密钥不会生效。

## 目录结构

```
index.html        页面结构与样式
src/main.js       应用逻辑（登录、消息渲染、网盘、下载、设置等）
src/stubs/os.js   Node os 模块的浏览器桩（构建用）
vite.config.js    构建配置（Node polyfill、os 别名）
patches/          telegram 依赖的补丁（patch-package）
public/           静态资源（如 _headers）
dist/             构建产物（部署用，勿手改）
```

## 隐私说明

- 本项目不收集任何用户数据；登录态仅保存在你自己的浏览器（`localStorage` / 会话字符串）。
- API 凭据与代理域名通过部署平台的环境变量注入，不应硬编码进源码或仓库。
- 请自行保管好 API 凭据，避免泄露。

## 免责声明

本项目仅供个人在合法合规前提下，管理自己拥有或有权访问的 Telegram 内容。使用本工具所产生的任何后果由使用者自行承担。
