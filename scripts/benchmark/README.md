# Benchmark Scripts

## `reconnect-latency.mjs`

测量终端通道重连耗时（`open -> auth.ok`）。

```bash
pnpm bench:reconnect -- --base-url=http://127.0.0.1:3000 --iterations=30 --assert-lt-ms=2000
```

可选参数：

- `--base-url`：服务地址，默认 `http://127.0.0.1:3000`
- `--bootstrap-token`：启动 token，不传则读取当前目录 `.auth-token`
- `--session-id`：复用已有会话
- `--iterations`：循环次数，默认 `20`
- `--timeout-ms`：单次超时，默认 `5000`
- `--assert-lt-ms`：p95 阈值，默认 `2000`

## `session-load.mjs`

并发终端连接压测，统计成功率与鉴权 p95。

```bash
pnpm bench:session-load -- --base-url=http://127.0.0.1:3000 --concurrency=20 --hold-ms=3000
```

可选参数：

- `--base-url`：服务地址
- `--bootstrap-token`：启动 token
- `--session-id`：复用已有会话
- `--concurrency`：并发连接数，默认 `20`
- `--hold-ms`：每连接保持时长，默认 `2000`
- `--timeout-ms`：连接/鉴权超时，默认 `5000`
- `--min-success-rate`：成功率阈值，默认 `0.995`

## `metrics-dump.mjs`

周期拉取 `/metrics` 并落盘，供基线报告引用。

```bash
pnpm bench:metrics-dump -- --base-url=http://127.0.0.1:3000 --duration-sec=120 --interval-ms=5000
```

可选参数：

- `--base-url`：服务地址
- `--duration-sec`：采样总时长，默认 `60`
- `--interval-ms`：采样间隔，默认 `5000`
- `--out`：输出文件路径，默认 `reports/raw/metrics-<timestamp>.prom`
