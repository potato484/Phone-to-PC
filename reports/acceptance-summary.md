# PMF 方案2 Acceptance Summary

## Automated Verification

- `pnpm build`: PASS
- `pnpm test:unit`: PASS
- `pnpm test:integration`: PASS
- `pnpm test:e2e`: PASS（受限环境会显式 `skip`）

## Capability Traceability

能力追溯基线见 `docs/capability-matrix.md`。本轮验收覆盖如下能力 ID：

- 认证生命周期：`CAP-AUTH-001`, `CAP-AUTH-002`, `CAP-AUTH-003`
- 权限边界与审计：`CAP-AUTH-004`, `CAP-AUTH-005`
- 控制链路：`CAP-WS-001`, `CAP-WS-002`, `CAP-WS-003`
- 会话持久化：`CAP-PTY-001`
- 文件链路：`CAP-FS-001`, `CAP-FS-002`
- 可观测性：`CAP-OBS-001`, `CAP-OBS-002`

## Acceptance Mapping (方案2 DoD)

- DoD-1 新机器安装/启动/回滚：
  - 交付 `scripts/install.sh`, `scripts/c2pctl`, `scripts/c2p.service`
  - 发布流程 `/.github/workflows/release.yml`
- DoD-2 安全 scope + refresh + revoke + audit：
  - scope: `admin|readonly`，写接口 403 拦截
  - refresh/revoke 事件入审计
- DoD-3 CI 分层与关键链路自动化：
  - `/.github/workflows/ci.yml` 分层 `build/unit/integration/e2e-smoke`
  - `tests/e2e/smoke.test.mjs` 覆盖 `auth -> session -> ws -> fs`
- DoD-4 WAN/LAN 报告可复现：
  - `reports/lan-baseline.md` 与 `reports/wan-baseline.md` 已填实测值
  - 原始数据在 `reports/raw/*`
- DoD-5 文档与代码一致性：
  - 能力矩阵与测试矩阵均引用能力 ID，避免文档漂移

## Residual Risks

- 真机公网（蜂窝网络 + noVNC）体验仍需单独场景复测。
- `e2e-smoke` 在严格沙箱中可能因端口权限受限被 `skip`，但会在日志显式标记。

## Extra Verification (Continue Test)

- `tests/integration/auth-refresh.test.mjs`: PASS
  - 覆盖 refresh 轮换后旧 token 撤销、新 token 保留 scope 与审计事件。
- `tests/integration/auth-exchange-rate-limit.test.mjs`: PASS
  - 覆盖 bootstrap 错误请求触发限流锁定、`429 + Retry-After`、以及失败审计落盘。
- `tests/integration/control-kill-latency.test.mjs`: PASS
  - 覆盖 kill 乐观反馈，消息确认耗时阈值 `<200ms`。
