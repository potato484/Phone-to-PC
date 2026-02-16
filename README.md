# C2P Controller

移动优先的远程终端控制 Web 应用。通过浏览器远程操控计算机的终端、桌面和文件系统，支持 Tailscale / Cloudflare Tunnel 隧道穿透，手机扫码即连。

## 功能

- 远程终端 — tmux 持久化会话，xterm.js + WebGL 渲染，OSC 52 剪贴板
- 远程桌面 — noVNC 实时桌面控制
- 文件管理 — 浏览、上传、下载
- 系统监控 — CPU / 内存 / 网络实时采样
- PWA — 离线缓存、可安装、Web Push 推送通知
- 隧道穿透 — Tailscale（serve / funnel）、Cloudflare Tunnel、Quick Tunnel
- 令牌认证 — 自动生成 64 位 hex token，timing-safe 校验

## 前置条件

### 必需

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 运行时，需支持 ES2022 |
| pnpm | >= 8 | 包管理器 |
| 构建工具链 | — | `node-pty` 需要本地编译（`python3`、`make`、`gcc`/`g++`） |
| tmux | >= 3 | 终端会话持久化与重启恢复 |

Linux 上安装编译依赖：

```bash
# Debian / Ubuntu
sudo apt install -y python3 make gcc g++

# Fedora
sudo dnf install -y python3 make gcc gcc-c++
```

### 可选

| 依赖 | 用途 |
|------|------|
| [Tailscale](https://tailscale.com/download) | 隧道穿透（推荐），需已登录并启用 HTTPS |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | Cloudflare Tunnel 穿透 |

## 快速开始

```bash
# 1. 克隆仓库
git clone <repo-url> && cd computer-to-phone

# 2. 安装依赖（自动复制 vendor 资源）
pnpm install

# 3. 生成 Web Push VAPID 密钥（写入 .env）
pnpm setup

# 4. 启动开发服务器（热重载）
pnpm dev
```

启动后终端会输出：

```
[c2p] listening on 3000
[c2p] local: http://localhost:3000/#token=<token>
[c2p] lan: http://192.168.x.x:3000/#token=<token>
[c2p] scan to connect:
█████████████████
█ QR Code here  █
█████████████████
```

手机扫描二维码或直接访问 URL 即可连接。

## 配置

复制 `.env.example` 为 `.env`，按需修改：

```bash
cp .env.example .env
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务监听端口 |
| `TUNNEL` | `auto` | 隧道模式：`tailscale` / `cloudflare` / `off` / `auto` |
| `TAILSCALE_FUNNEL` | `false` | `true` = funnel（公网可访问），`false` = serve（仅 Tailnet 内） |
| `TUNNEL_HOSTNAME` | — | Cloudflare 命名隧道的域名（留空则使用 Quick Tunnel） |
| `VAPID_SUBJECT` | `mailto:you@example.com` | Web Push 联系邮箱 |
| `VAPID_PUBLIC_KEY` | — | VAPID 公钥（`pnpm setup` 自动生成） |
| `VAPID_PRIVATE_KEY` | — | VAPID 私钥（`pnpm setup` 自动生成） |

### 隧道模式详解

**auto**（默认）：优先尝试 Cloudflare 命名隧道 → Quick Tunnel，均失败则 LAN-only。

**tailscale**：通过 Tailscale 暴露服务。
- `TAILSCALE_FUNNEL=false`：仅 Tailnet 内设备可访问（`tailscale serve`）
- `TAILSCALE_FUNNEL=true`：公网可访问（`tailscale funnel`），需在 Tailscale 管理面板启用 Funnel

**cloudflare**：
- 设置 `TUNNEL_HOSTNAME`：使用已配置的命名隧道（需提前 `cloudflared tunnel create`）
- 不设置：使用 Quick Tunnel（`trycloudflare.com` 临时域名）

**off**：禁用隧道，仅 LAN 访问。

### 认证

服务首次启动时自动生成 `.auth-token`（bootstrap token），用于换取 24h access token：

- 首次访问：`http://host:port/#token=<bootstrap_token>`
- 访问令牌：REST 仅支持 `Authorization: Bearer <access_token>`
- WebSocket：连接后 2s 内发送首帧 `{\"type\":\"auth\",\"token\":\"<access_token>\"}`

### CLI 参数

```bash
# 指定终端默认工作目录
pnpm start -- --cwd=/path/to/workspace
```

## 构建与部署

```bash
# 编译 TypeScript
pnpm build

# 自动化测试（单测 + 集成）
pnpm test

# 重连与并发基线脚本
pnpm bench:reconnect -- --base-url=http://127.0.0.1:3000
pnpm bench:session-load -- --base-url=http://127.0.0.1:3000 --concurrency=20

# 生产启动
pnpm start

# 或直接
node dist/server.js --cwd=/home/user/projects
```

## 项目结构

```
src/
├── server.ts          # 入口，Express + WebSocket 初始化
├── auth.ts            # 令牌认证
├── pty-manager.ts     # tmux 会话管理与恢复
├── vnc-manager.ts     # VNC 桌面控制
├── tunnel.ts          # 隧道穿透（Tailscale / Cloudflare）
├── push.ts            # Web Push 推送
├── store.ts           # 持久化存储
├── routes/api.ts      # REST API（系统监控、文件操作）
└── ws/
    ├── channel.ts     # WebSocket 通道基类
    ├── control.ts     # 控制通道（会话生命周期）
    ├── terminal.ts    # 终端通道（PTY 数据流）
    └── desktop.ts     # 桌面通道（VNC）

public/
├── index.html         # 主页面
├── app.js             # 前端逻辑
├── style.css          # Catppuccin Mocha 主题
├── sw.js              # Service Worker
└── manifest.json      # PWA 清单
```

## 技术栈

**后端**：TypeScript · Express · node-pty · ws · web-push

**前端**：Vanilla JS · xterm.js (WebGL) · noVNC · PWA

## License

Private
