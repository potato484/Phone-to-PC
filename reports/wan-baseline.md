# WAN Baseline Report

- Date: `TBD`
- Environment: `WAN (Tailscale / Tunnel)`
- Device Matrix: `Android Chrome + iOS Safari (TBD)`
- Server Build: `TBD`

## Runbook

1. `pnpm bench:reconnect -- --base-url=https://<public-host> --iterations=30 --assert-lt-ms=2000`
2. `pnpm bench:session-load -- --base-url=https://<public-host> --concurrency=20 --hold-ms=3000`
3. `pnpm bench:metrics-dump -- --base-url=https://<public-host> --duration-sec=120 --interval-ms=5000`

## Network Matrix

- Added delay: `50ms / 100ms / 150ms`
- Packet loss: `0.5% / 1%`
- Jitter: `±20ms`

## KPI Results

- WS connect+auth success rate: `TBD`
- Terminal reconnect p95: `TBD` ms (target `< 2000ms`)
- WS RTT p95: `TBD` ms
- Event-loop lag p95: `TBD` ms

## Metrics Artifact

- Raw dump: `reports/raw/<file>.prom`
- Dashboard screenshot: `TBD`

## Notes

- Tunnel mode: `TBD`
- Issues found: `TBD`
- Conclusion: `TBD`
