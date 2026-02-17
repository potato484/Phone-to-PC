# WAN Baseline Report

- Date: `2026-02-17`
- Environment: `LAN IP path rehearsal (192.168.1.50), no tunnel/netem injection`
- Device Matrix: `Ubuntu 22.04 host (Node 22.22.0) + fake tmux backend`
- Server Build: `dist/server.js (local main workspace)`

## Runbook (Executed Commands)

1. `pnpm bench:reconnect -- --base-url=http://192.168.1.50:3900 --bootstrap-token=<token> --iterations=20 --assert-lt-ms=2000`
2. `pnpm bench:session-load -- --base-url=http://192.168.1.50:3900 --bootstrap-token=<token> --concurrency=20 --hold-ms=4000 --min-success-rate=0.99`
3. `pnpm bench:metrics-dump -- --base-url=http://192.168.1.50:3900 --duration-sec=30 --interval-ms=5000 --out=reports/raw/wan-baseline-2026-02-17.prom`

## Network Matrix

- Added delay: `none (not injected in this run)`
- Packet loss: `none (not injected in this run)`
- Jitter: `none (not injected in this run)`

## KPI Results

- WS connect+auth success rate: `100.00%` (PASS, target `>= 99%`)
- Terminal reconnect p95: `7.14 ms` (PASS, target `< 2000ms`)
- Event-loop lag p95 (max snapshot): `21.168 ms` (PASS, target `< 50ms`)
- Memory at 20 sessions (RSS max): `70.17 MB` (PASS, target `< 500MB`)

## Metrics Artifact

- Reconnect log: `reports/raw/wan-reconnect-2026-02-17.log`
- Session-load log: `reports/raw/wan-session-load-2026-02-17.log`
- Raw metrics: `reports/raw/wan-baseline-2026-02-17.prom`

## Conclusion

- Decision: `No-Go (for external mobile WAN claim), Go (for current LAN-IP rehearsal)`
- Notes: 本次数据已满足阈值，但未经过公网/蜂窝网络和隧道链路验证，需在真机 WAN 场景复测后再放行外网质量结论。
