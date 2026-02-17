# LAN Baseline Report

- Date: `2026-02-17`
- Environment: `LAN / loopback`
- Device Matrix: `Ubuntu 22.04 host (Node 22.22.0) + fake tmux backend`
- Server Build: `dist/server.js (local main workspace)`

## Runbook (Executed Commands)

1. `pnpm bench:reconnect -- --base-url=http://127.0.0.1:3900 --bootstrap-token=<token> --iterations=30 --assert-lt-ms=2000`
2. `pnpm bench:session-load -- --base-url=http://127.0.0.1:3900 --bootstrap-token=<token> --concurrency=20 --hold-ms=3000 --min-success-rate=0.99`
3. `pnpm bench:metrics-dump -- --base-url=http://127.0.0.1:3900 --duration-sec=30 --interval-ms=5000 --out=reports/raw/lan-baseline-2026-02-17.prom`

## KPI Results

- WS connect+auth success rate: `100.00%` (PASS, target `>= 99%`)
- Terminal reconnect p95: `8.24 ms` (PASS, target `< 2000ms`)
- Event-loop lag p95 (max snapshot): `20.578 ms` (PASS, target `< 50ms`)
- Memory at 20 sessions (RSS max): `74.49 MB` (PASS, target `< 500MB`)

## Metrics Artifact

- Reconnect log: `reports/raw/lan-reconnect-2026-02-17.log`
- Session-load log: `reports/raw/lan-session-load-2026-02-17.log`
- Raw metrics: `reports/raw/lan-baseline-2026-02-17.prom`

## Conclusion

- Decision: `Go`
- Notes: 结果满足方案2 Gate D 阈值；该基线为内网/同机链路，不代表公网弱网体感。
