# MVP + PMF Stage1 Acceptance Summary

## Automated Verification

- `pnpm build`: PASS
- `pnpm test`: PASS
  - `tests/unit/auth-token.test.mjs`
  - `tests/unit/desktop-quality-policy.test.mjs`
  - `tests/unit/store-migration.test.mjs`
  - `tests/unit/store-telemetry.test.mjs`
  - `tests/unit/pty-manager-tmux.test.mjs` (受限环境可能 skip)
  - `tests/integration/control-heartbeat.test.mjs` (受限环境可能 skip)
  - `tests/integration/tmux-recovery.test.mjs` (受限环境可能 skip)

## Covered Acceptance Items

- 安全认证体系：access token 签发/校验/吊销、WS 首帧鉴权、限流与审计链路已接入。
- 会话持久化：`tmux` 会话创建、attach/detach、`SQLite sessions` 恢复、服务重启后会话恢复列表。
- 可观测性：`/healthz`、`/readyz`、`/metrics` 与 event-loop 指标可用。
- 压测资产：`scripts/benchmark/*` 与 `reports/lan-baseline.md`、`reports/wan-baseline.md` 已提供。
- PMF 阶段 1 工程闭环（最小可验收包）：
  - 控制通道应用层心跳：`heartbeat.ping/pong` 已接入（用于 RTT/抖动/丢包采样）。
  - CQS 客户端评分：前端实时计算并展示 `CQS/RTT/抖动/丢包`，并触发桌面质量档位自动升降。
  - 触控体验增强：`触控/触板` 双模式切换 + 国际文本输入入口。
  - 桌面弱网策略：`/ws/desktop` 支持 `low/balanced/high` 质量档位并按档位调整背压阈值。
  - 匿名遥测（opt-in）：新增 `/api/telemetry/events` 与 `/api/telemetry/summary`，落库与聚合可用。

## Pending External Validation

- 真机与 WAN 压测需在可监听端口、具备真实 `tmux` 与移动网络环境中执行。
- 桌面链路的弱网体感与端侧渲染效果仍需在真机 noVNC 场景下做专项验证。
- Playwright 端到端浏览器自动化需在可联网安装依赖后补齐。
