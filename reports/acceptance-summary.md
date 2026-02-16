# MVP Acceptance Summary

## Automated Verification

- `pnpm build`: PASS
- `pnpm test`: PASS
  - `tests/unit/auth-token.test.mjs`
  - `tests/unit/store-migration.test.mjs`
  - `tests/unit/pty-manager-tmux.test.mjs` (受限环境可能 skip)
  - `tests/integration/tmux-recovery.test.mjs` (受限环境可能 skip)

## Covered Acceptance Items

- 安全认证体系：access token 签发/校验/吊销、WS 首帧鉴权、限流与审计链路已接入。
- 会话持久化：`tmux` 会话创建、attach/detach、`SQLite sessions` 恢复、服务重启后会话恢复列表。
- 可观测性：`/healthz`、`/readyz`、`/metrics` 与 event-loop 指标可用。
- 压测资产：`scripts/benchmark/*` 与 `reports/lan-baseline.md`、`reports/wan-baseline.md` 已提供。

## Pending External Validation

- 真机与 WAN 压测需在可监听端口、具备真实 `tmux` 与移动网络环境中执行。
- Playwright 端到端浏览器自动化需在可联网安装依赖后补齐。
