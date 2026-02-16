# LAN Baseline Report

- Date: `TBD`
- Environment: `LAN / Wi-Fi`
- Device Matrix: `Android Chrome + iOS Safari (TBD)`
- Server Build: `TBD`

## Runbook

1. `pnpm bench:reconnect -- --base-url=http://<host>:3000 --iterations=30 --assert-lt-ms=2000`
2. `pnpm bench:session-load -- --base-url=http://<host>:3000 --concurrency=20 --hold-ms=3000`
3. `pnpm bench:metrics-dump -- --base-url=http://<host>:3000 --duration-sec=120 --interval-ms=5000`

## KPI Results

- WS connect+auth success rate: `TBD`
- Terminal reconnect p95: `TBD` ms (target `< 2000ms`)
- Event-loop lag p95: `TBD` ms (target `< 50ms`)
- Memory at 20 sessions: `TBD` MB (target `< 500MB`)

## Metrics Artifact

- Raw dump: `reports/raw/<file>.prom`
- Dashboard screenshot: `TBD`

## Notes

- Weak network injection: `N/A` in LAN baseline
- Issues found: `TBD`
- Conclusion: `TBD`
