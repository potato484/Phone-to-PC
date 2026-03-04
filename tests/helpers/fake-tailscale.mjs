#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const mode = (process.env.FAKE_TAILSCALE_MODE || 'online').trim().toLowerCase();
const args = process.argv.slice(2);

function fail(message, code = 1) {
  fs.writeSync(process.stderr.fd, `${message}\n`);
  process.exit(code);
}

function writeJson(payload) {
  fs.writeSync(process.stdout.fd, `${JSON.stringify(payload)}\n`);
}

if (args.length === 0) {
  fail('fake tailscale: missing command');
}

const command = args[0];
if (command === 'status') {
  if (args[1] !== '--json') {
    fail('fake tailscale: expected "status --json"');
  }
  if (mode === 'status-error') {
    fail('fake tailscale: status failed');
  } else if (mode === 'invalid-json') {
    fs.writeSync(process.stdout.fd, '{invalid-json\n');
  } else if (mode === 'offline') {
    writeJson({
      Self: {
        DNSName: 'fake-node.tailnet.ts.net.',
        Online: false,
        TailscaleIPs: ['100.64.0.1']
      }
    });
  } else if (mode === 'missing-dns') {
    writeJson({
      Self: {
        Online: true,
        TailscaleIPs: ['100.64.0.1']
      }
    });
  } else {
    writeJson({
      Self: {
        DNSName: 'fake-node.tailnet.ts.net.',
        Online: true,
        TailscaleIPs: ['100.64.0.1']
      }
    });
  }
  process.exitCode = 0;
} else if (command === 'serve' || command === 'funnel') {
  if (mode === 'serve-fail') {
    fail(`fake tailscale: ${command} failed`);
  }
  process.exitCode = 0;
} else {
  fail(`fake tailscale: unsupported command "${command}"`);
}
