# MVP Test Matrix

## Automated (Local)

- Unit: `tests/unit/auth-token.test.mjs`
- Unit: `tests/unit/store-migration.test.mjs`
- Integration: `tests/integration/tmux-recovery.test.mjs`

Run command:

```bash
pnpm test
```

## Coverage Mapping

- Auth issuance/verify/revoke: covered by `auth-token.test.mjs`
- JSON -> SQLite migration idempotence: covered by `store-migration.test.mjs`
- WS first-frame auth + spawn + reconnect `<2s` + restart recovery: covered by `tmux-recovery.test.mjs`

## E2E / Real Device

- Browser E2E (Playwright): `待补充（当前环境无法联网安装依赖）`
- Android/iOS real-device runs: `待补充（按 reports/lan-baseline.md 与 reports/wan-baseline.md 记录）`

## Risks

- `vitest/playwright` 未在当前离线环境安装，当前自动化采用 `node:test` 作为替代。
- 真实 `tmux` 未在当前环境安装，集成测试使用 `tests/helpers/fake-tmux.mjs` 模拟。
