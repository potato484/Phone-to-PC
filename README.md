# C2P Controller

移动优先的远程控制 Web 应用。你可以直接在手机浏览器里管理电脑的终端和文件。

## 主要服务对象

- 主要面向有 Linux/WSL 主机的个人开发者、运维、实验室/家庭自托管用户。
- 核心诉求是“手机随时接管电脑终端”，并且要求低延迟、稳定连接。

## 连通方案（强烈推荐 Tailscale）

`Tailscale` 是本项目推荐的默认连通方式。  
原因：在本项目的实际远程交互场景里，`cloudflare` 的连接效果通常明显差于 `tailscale`（更高延迟、更容易抖动）。

结论：
- 生产/日常使用：优先 `Tailscale`
- `cloudflare`：仅作为兜底或临时排障，不建议作为常态连接方案

## 功能概览

- 远程终端：tmux 持久化会话，重连可恢复
- 文件管理：浏览/上传/下载/重命名/删除/新建文件
- 系统监控：CPU/内存/网络 + CQS（连接质量评分）
- 认证与安全：bootstrap token -> access token，支持吊销

## 平台支持

- Linux：完整支持（推荐）
- WSL2（Ubuntu 等）：可用，推荐
- macOS：可运行部分能力，但不是主支持平台
- Windows 原生：不建议（终端链路依赖 tmux 与 `/bin/bash`）

## 前置条件

### 必需

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 22 | 运行时（依赖 `node:sqlite`） |
| pnpm | >= 9 | 包管理器 |
| tmux | >= 3 | 终端会话持久化 |
| 构建工具链 | - | `node-pty` 编译需要 `python3`/`make`/`gcc`/`g++` |

### 推荐

| 依赖 | 说明 |
|------|------|
| Tailscale | 用于手机与电脑之间的稳定连通 |

## 运行环境约束

- 主机环境：`Linux Ubuntu 22.04`（首要验证目标）；
- `tmux` 不可用时，终端能力会降级（`/readyz` 也会反映非就绪）；
- 在受限沙箱环境里，端口监听可能被禁用，`integration/e2e/benchmark` 会显式跳过或失败并输出原因；
- Python 命令统一使用 `python3`。

## 一键安装（推荐）

使用仓库内置脚本：

```bash
bash scripts/install.sh --install-dir /opt/c2p --service-user "$USER"
```

脚本能力：

- 自动检测发行版（Debian/Ubuntu/Fedora/Arch）并安装基础依赖
- 拉取/更新仓库并执行 `pnpm install` + `pnpm build`
- 生成 `.env`（不覆盖已存在键，仅补缺省）
- 安装 `systemd` 模板与 `c2pctl`
- 可选安装 Tailscale（可通过 `--skip-tailscale` 跳过）

常用参数：

- `--non-interactive`
- `--install-dir <path>`（默认 `/opt/c2p`）
- `--service-user <user>`
- `--skip-tailscale`

## 用户必须配置的部分

### 必改项

1. Tailscale 登录
- 必须执行：`sudo tailscale up`
- 电脑与手机都需登录到同一个 Tailnet

2. 启动工作目录（建议）
- 通过 `--cwd` 指定文件管理根目录，避免暴露不必要路径
- 终端新会话默认仍从 Linux 用户目录 `~` 启动
- 示例：`pnpm start -- --cwd=/home/your-user/workspace`

### 按需配置

1. `TAILSCALE_FUNNEL`
- `false`：仅 Tailnet 内访问（推荐）
- `true`：公网访问（需在 Tailscale 管理端启用 Funnel）

2. `PORT`
- 默认 `3000`，端口冲突时修改

3. 安全白名单
- `C2P_ALLOWED_ORIGINS`
- `C2P_ALLOWED_HOSTS`
- `C2P_ALLOW_EMPTY_ORIGIN`

## 详细配置（.env）

先准备配置文件：

```bash
cp .env.example .env
```

### 核心连接配置

| 变量 | 代码默认值 | 推荐值 | 说明 |
|------|------------|--------|------|
| `PORT` | `3000` | `3000` | 服务监听端口 |
| `TUNNEL` | `auto` | `tailscale` | 隧道模式：`tailscale` / `cloudflare` / `off` / `auto` |
| `TAILSCALE_FUNNEL` | `false` | `false` | `true`=公网，`false`=仅 Tailnet 内 |
| `TUNNEL_HOSTNAME` | 空 | 空 | Cloudflare 命名隧道域名（仅 cloudflare 模式） |

### 认证配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `C2P_ACCESS_TOKEN_TTL_SECONDS` | `86400` | access token 过期秒数 |

### 存储与审计

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `C2P_DB_PATH` | `./.c2p-store.sqlite` | SQLite 文件路径 |
| `C2P_AUDIT_DIR` | `./.c2p-audit` | 审计日志目录 |
| `C2P_AUDIT_RETENTION_DAYS` | `90` | 审计日志保留天数 |
| `C2P_TMUX_BIN` | `tmux` | tmux 可执行路径 |

### 安全策略（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `C2P_ALLOWED_ORIGINS` | 空 | 允许的 Origin 列表（逗号分隔） |
| `C2P_ALLOWED_HOSTS` | 空 | 允许的 Host 列表（逗号分隔） |
| `C2P_ALLOW_EMPTY_ORIGIN` | `true` | 是否允许无 Origin 请求 |

## 启动

开发模式：

```bash
pnpm dev
```

生产模式：

```bash
pnpm build
pnpm start -- --cwd=/path/to/workspace
```

启动后会输出：
- 本地访问地址
- 局域网地址
- Tailscale 地址（若启用）
- 可扫码连接的 URL（含 token）

## 连接地址与 Token 注意事项（必读）

1. 访问 URL 必须带 `#token`
- 正确格式：`https://<域名或IP>/#token=<bootstrap_token>`
- 例如：`https://xxxx.trycloudflare.com/#token=...`
- 仅打开 `https://xxxx.trycloudflare.com`（不带 `#token`）会被视为未登录

2. `bootstrap token` 获取方式
- 默认保存在服务端工作目录：`.auth-token`
- 查看命令：`cat /home/potato/Phone-to-PC/.auth-token`

3. 为什么会出现“token 无效或已过期”
- 浏览器里的 `access token` 是短期票据（默认 24h），会过期或被刷新轮换
- 失效后需要重新使用带 `#token` 的完整链接进入

4. 首次登录后地址栏变化
- 页面认证成功后会清理 URL 中的 `#token`
- 如果你直接复制“已清理后的地址”再次打开，就会缺少登录 token
- 解决方式：重新使用启动日志输出的 bootstrap 链接，或手动按格式拼接 `#token=...`

## systemd / c2pctl

安装脚本会部署 `c2p@.service` 与 `c2pctl`，常用命令：

```bash
sudo systemctl enable --now c2p@<user>.service
c2pctl status --user <user> --install-dir /opt/c2p
c2pctl restart --user <user>
c2pctl logs --user <user>
```

`c2pctl status` 的退出码约定：

- `0`：`service=active` 且 `healthz/readyz=200`
- 非 `0`：任一检查异常

## 隧道模式说明

### `tailscale`（推荐）

- 程序会自动执行 `tailscale serve` 或 `tailscale funnel`（按 `TAILSCALE_FUNNEL` 决定）。
- 你只需要确保：`tailscale up` 已登录且在线。

### `cloudflare`（不推荐，兜底）

- 在本项目中，`cloudflare` 实测通常比 `tailscale` 连接体验差，仅建议临时使用。
- 使用方式：
  - 设置 `TUNNEL=cloudflare`
  - 可选设置 `TUNNEL_HOSTNAME` 走命名隧道
  - 不设置则走 Quick Tunnel
- 重启服务后，以日志输出的 `tunnel: https://.../#token=...` 为准直接访问

### `off`

- 关闭隧道，仅局域网访问。

### `auto`

- 按代码逻辑自动选择，不建议用于生产可控场景。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm start -- --cwd=/your/workspace
```

## License

Private
