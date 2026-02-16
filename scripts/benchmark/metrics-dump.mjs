#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) {
      continue;
    }
    const [key, value = ''] = item.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args['base-url'] || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const durationSec = Math.max(5, Number.parseInt(args['duration-sec'] || '60', 10));
  const intervalMs = Math.max(1000, Number.parseInt(args['interval-ms'] || '5000', 10));

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.resolve(args.out || `reports/raw/metrics-${timestamp}.prom`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const startedAt = Date.now();
  const chunks = [];

  while (Date.now() - startedAt < durationSec * 1000) {
    const now = new Date().toISOString();
    const response = await fetch(`${baseUrl}/metrics`);
    if (!response.ok) {
      throw new Error(`fetch /metrics failed status=${response.status}`);
    }
    const body = await response.text();
    chunks.push(`# snapshot_at=${now}\n${body.trim()}\n`);
    await sleep(intervalMs);
  }

  await fs.writeFile(outputPath, `${chunks.join('\n')}\n`, 'utf8');

  console.log('Metrics dump completed');
  console.log(`Base URL   : ${baseUrl}`);
  console.log(`Duration   : ${durationSec}s`);
  console.log(`Interval   : ${intervalMs}ms`);
  console.log(`Output file: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`metrics dump failed: ${message}`);
  process.exit(1);
});
