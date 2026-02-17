# Capability Matrix (Phase A Baseline)

| ID | 能力项 | 代码入口 | API/WS 协议 | 自动化覆盖 | 已知限制 |
|---|---|---|---|---|---|
| CAP-AUTH-001 | bootstrap token 交换 access token | `src/server.ts`, `src/auth.ts` | `POST /api/auth/exchange` | `tests/unit/auth-token.test.mjs`, `tests/e2e/smoke.test.mjs` | 依赖本地 `.auth-token` 文件；错误 token 会触发限流锁定。 |
| CAP-AUTH-006 | bootstrap 失败限流与锁定 | `src/server.ts`, `src/security.ts` | `POST /api/auth/exchange`（失败链路） | `tests/integration/auth-exchange-rate-limit.test.mjs` | 限流窗口内被锁定后，连正确 token 也会返回 `429`，需等待 `Retry-After`。 |
| CAP-AUTH-002 | access token 刷新（rotate） | `src/server.ts`, `src/auth.ts` | `POST /api/auth/refresh` | `tests/unit/auth-token.test.mjs` | 仅在 token 仍有效时可刷新，旧 token 会被撤销。 |
| CAP-AUTH-003 | access token 主动吊销 | `src/server.ts`, `src/auth.ts` | `POST /api/auth/revoke` | `tests/unit/auth-token.test.mjs`, `tests/integration/api-scope-enforcement.test.mjs` | 为自撤销语义；需携带有效 bearer token。 |
| CAP-AUTH-004 | scope 权限边界（`admin`/`readonly`） | `src/auth.ts`, `src/routes/api.ts` | `/api/fs/*`, `/api/telemetry/events` 的写操作 scope 校验 | `tests/integration/api-scope-enforcement.test.mjs` | 当前仅覆盖 API 写操作，WS 控制通道仍按现有模型工作。 |
| CAP-AUTH-005 | scope 拒绝审计 | `src/routes/api.ts`, `src/audit-log.ts` | 审计事件 `auth.denied_scope` | `tests/integration/api-scope-enforcement.test.mjs` | 审计文件是异步写入，测试与排障需考虑轻微延迟。 |
| CAP-WS-001 | WS 首帧鉴权（control/terminal） | `src/ws/auth-gate.ts`, `src/ws/control.ts`, `src/ws/terminal.ts` | `type=auth` 首帧 + `auth.ok` | `tests/integration/control-heartbeat.test.mjs`, `tests/integration/tmux-recovery.test.mjs`, `tests/e2e/smoke.test.mjs` | 受 ws 限流器保护；高频重连可能命中 429/4401。 |
| CAP-WS-002 | 控制通道心跳 RTT 采样 | `src/ws/control.ts`, `public/lib/quality.js` | `heartbeat.ping` / `heartbeat.pong` | `tests/integration/control-heartbeat.test.mjs` | 结果受客户端时钟与网络抖动影响。 |
| CAP-WS-003 | 会话 spawn/kill 广播与乐观更新 | `src/ws/control.ts`, `src/pty-manager.ts`, `public/lib/ui.js` | `spawn`, `kill`, `sessions`, `exited` | `tests/e2e/smoke.test.mjs`, `tests/unit/pty-manager-tmux.test.mjs` | kill 为异步清理；极端场景会短暂依赖后续 `sessions` 校准。 |
| CAP-PTY-001 | tmux 会话恢复与持久化映射 | `src/server.ts`, `src/pty-manager.ts`, `src/store.ts` | 服务启动恢复 + `GET /api/sessions` | `tests/integration/tmux-recovery.test.mjs` | 依赖 `tmux` 可用性；无 tmux 时终端能力降级。 |
| CAP-FS-001 | 文件系统读链路 | `src/routes/api.ts` | `GET /api/fs/list`, `GET /api/fs/read`, `GET /api/fs/download` | `tests/e2e/smoke.test.mjs` | 路径必须位于 `--cwd` 基目录，读文件大小受上限保护。 |
| CAP-FS-002 | 文件系统写链路 + 审计 | `src/routes/api.ts`, `src/audit-log.ts` | `POST /api/fs/write|mkdir|rename|remove|upload`，审计 `fs.*` | `tests/integration/api-scope-enforcement.test.mjs`, `tests/e2e/smoke.test.mjs` | `readonly` token 全量 403；上传受大小和剩余磁盘阈值限制。 |
| CAP-OBS-001 | 健康与就绪检查 | `src/server.ts`, `src/store.ts`, `src/pty-manager.ts` | `GET /healthz`, `GET /readyz` | `tests/integration/control-heartbeat.test.mjs`（间接）、`tests/e2e/smoke.test.mjs`（间接） | `readyz` 依赖 sqlite 可写和 pty 可用。 |
| CAP-OBS-002 | Prometheus 指标与压测采样 | `src/metrics.ts`, `scripts/benchmark/metrics-dump.mjs` | `GET /metrics` | `reports/raw/lan-baseline-2026-02-17.prom`, `reports/raw/wan-baseline-2026-02-17.prom` | 真实 WAN 数据仍依赖外网/真机链路环境。 |
| CAP-TELEM-001 | 匿名遥测汇总查询 | `src/routes/api.ts`, `src/store.ts` | `GET /api/telemetry/summary` | `tests/integration/api-scope-enforcement.test.mjs` | 遥测写入默认 admin scope；summary 为窗口聚合结果。 |
