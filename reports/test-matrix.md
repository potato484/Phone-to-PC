# PMF 方案2 Test Matrix

## CI Layers

1. `build`: `pnpm build`
2. `unit`: `pnpm test:unit`
3. `integration`: `pnpm test:integration`
4. `e2e-smoke`: `pnpm test:e2e`

## Coverage by Capability ID

- `CAP-AUTH-001` `CAP-AUTH-003`:
  - `tests/unit/auth-token.test.mjs`
- `CAP-AUTH-002`:
  - `tests/unit/auth-token.test.mjs`
  - `tests/integration/auth-refresh.test.mjs`
- `CAP-AUTH-006`:
  - `tests/integration/auth-exchange-rate-limit.test.mjs`
- `CAP-AUTH-004` `CAP-AUTH-005`:
  - `tests/integration/api-scope-enforcement.test.mjs`
- `CAP-WS-001` `CAP-WS-002`:
  - `tests/integration/control-heartbeat.test.mjs`
- `CAP-WS-003`:
  - `tests/integration/control-kill-latency.test.mjs`
- `CAP-PTY-001`:
  - `tests/integration/tmux-recovery.test.mjs`
  - `tests/unit/pty-manager-tmux.test.mjs`
- `CAP-FS-001` `CAP-FS-002`:
  - `tests/e2e/smoke.test.mjs`
  - `tests/integration/api-scope-enforcement.test.mjs`
- `CAP-OBS-001`:
  - `tests/integration/control-heartbeat.test.mjs`（服务存活）
- `CAP-OBS-002`:
  - `scripts/benchmark/metrics-dump.mjs`
  - `reports/raw/lan-baseline-2026-02-17.prom`
  - `reports/raw/wan-baseline-2026-02-17.prom`

## Skip Policy

- `integration` 与 `e2e-smoke` 若遇端口/沙箱限制，必须在 `node:test` 输出中显式 `skip` 原因。
- CI 中 `e2e-smoke` 当前为非阻断任务（`continue-on-error: true`），结果仍会保留日志。

## Known Gaps

- 真机 WAN（移动网络）质量体验不在当前自动化覆盖范围内，依赖 `reports/wan-baseline.md` 的手工回归流程。
