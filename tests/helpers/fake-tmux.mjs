#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const stateFile = process.env.FAKE_TMUX_STATE_FILE || path.join(process.cwd(), '.fake-tmux-state.json');

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid fake tmux state');
    }
    return {
      nextPaneId: Number.isFinite(parsed.nextPaneId) ? Math.max(1, Math.floor(parsed.nextPaneId)) : 1,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      panes: parsed.panes && typeof parsed.panes === 'object' ? parsed.panes : {}
    };
  } catch {
    return {
      nextPaneId: 1,
      sessions: {},
      panes: {}
    };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, 'utf8');
}

function hasSessions(state) {
  return Object.keys(state.sessions).length > 0;
}

function failNoServer() {
  process.stderr.write('no server running on /tmp/fake-tmux/default\n');
  process.exit(1);
}

function failMissingSession(name) {
  process.stderr.write(`can't find session: ${name}\n`);
  process.exit(1);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    return '';
  }
  return args[index + 1] || '';
}

function parseIntOption(args, name, fallback) {
  const raw = readOption(args, name);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function renderFormat(format, session) {
  return format
    .replaceAll('#{session_name}', session.name)
    .replaceAll('#{pane_current_path}', session.cwd)
    .replaceAll('#{window_width}', String(session.cols))
    .replaceAll('#{window_height}', String(session.rows))
    .replaceAll('#{session_created}', String(session.createdAt))
    .replaceAll('#{pane_id}', session.paneId);
}

function normalizeQuotedPath(rawValue) {
  let value = rawValue.trim();
  if (!value) {
    return '';
  }
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/'\\''/g, "'");
}

function parsePipeTargetPath(command) {
  const match = command.match(/cat\s*>>\s*(.+)$/);
  if (!match) {
    return '';
  }
  return normalizeQuotedPath(match[1]);
}

function appendOutput(session, text) {
  if (!text) {
    return;
  }
  if (session.logPath) {
    fs.mkdirSync(path.dirname(session.logPath), { recursive: true });
    fs.appendFileSync(session.logPath, text, 'utf8');
  }
}

function getSessionByTarget(state, target) {
  if (state.sessions[target]) {
    return state.sessions[target];
  }
  const byPane = state.panes[target];
  if (byPane && state.sessions[byPane]) {
    return state.sessions[byPane];
  }
  return null;
}

function attachSessionLoop(sessionName) {
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  process.on('SIGTERM', () => {
    process.exit(0);
  });
  process.on('SIGINT', () => {
    process.exit(0);
  });

  const stopIfMissing = () => {
    const state = readState();
    if (!state.sessions[sessionName]) {
      process.exit(0);
    }
  };

  const watcher = setInterval(stopIfMissing, 150);
  watcher.unref();

  process.stdin.on('data', (chunk) => {
    const state = readState();
    const session = state.sessions[sessionName];
    if (!session) {
      process.exit(0);
      return;
    }

    appendOutput(session, chunk);
    writeState(state);
    process.stdout.write(chunk);
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('fake tmux: missing command\n');
    process.exit(1);
  }

  if (args[0] === '-V') {
    process.stdout.write('tmux fake-3.3\n');
    process.exit(0);
  }

  const command = args[0];
  const state = readState();

  if (command === 'new-session') {
    const name = readOption(args, '-s');
    if (!name) {
      process.stderr.write('fake tmux: missing -s\n');
      process.exit(1);
    }
    const cols = parseIntOption(args, '-x', 100);
    const rows = parseIntOption(args, '-y', 30);
    const cwd = readOption(args, '-c') || process.cwd();
    const paneId = `%${state.nextPaneId}`;
    state.nextPaneId += 1;
    state.sessions[name] = {
      name,
      cwd,
      cols,
      rows,
      createdAt: Math.floor(Date.now() / 1000),
      paneId,
      logPath: ''
    };
    state.panes[paneId] = name;
    writeState(state);
    process.exit(0);
  }

  if (command === 'list-panes') {
    if (!hasSessions(state)) {
      failNoServer();
    }

    const format = readOption(args, '-F') || '#{session_name}';
    const target = readOption(args, '-t');
    let list = Object.values(state.sessions);

    if (target) {
      const session = getSessionByTarget(state, target);
      if (!session) {
        failMissingSession(target);
      }
      list = [session];
    }

    const lines = list.map((session) => renderFormat(format, session));
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  }

  if (command === 'pipe-pane') {
    const target = readOption(args, '-t');
    if (!target) {
      process.stderr.write('fake tmux: missing -t\n');
      process.exit(1);
    }
    const session = getSessionByTarget(state, target);
    if (!session) {
      failMissingSession(target);
    }

    const pipeCommand = args[args.length - 1] || '';
    const logPath = parsePipeTargetPath(pipeCommand);
    if (logPath) {
      session.logPath = logPath;
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.closeSync(fs.openSync(logPath, 'a', 0o600));
      writeState(state);
    }
    process.exit(0);
  }

  if (command === 'attach-session') {
    const target = readOption(args, '-t');
    if (!target || !state.sessions[target]) {
      failMissingSession(target || '');
    }
    attachSessionLoop(target);
    return;
  }

  if (command === 'resize-window') {
    const target = readOption(args, '-t');
    const session = target ? state.sessions[target] : null;
    if (!session) {
      failMissingSession(target || '');
    }
    session.cols = parseIntOption(args, '-x', session.cols);
    session.rows = parseIntOption(args, '-y', session.rows);
    writeState(state);
    process.exit(0);
  }

  if (command === 'kill-session') {
    const target = readOption(args, '-t');
    const session = target ? state.sessions[target] : null;
    if (!session) {
      failMissingSession(target || '');
    }
    delete state.panes[session.paneId];
    delete state.sessions[target];
    writeState(state);
    process.exit(0);
  }

  if (command === 'has-session') {
    const target = readOption(args, '-t');
    if (!target || !state.sessions[target]) {
      failMissingSession(target || '');
    }
    process.exit(0);
  }

  if (command === 'list-sessions') {
    if (!hasSessions(state)) {
      failNoServer();
    }

    const format = readOption(args, '-F') || '#{session_name}';
    const lines = Object.values(state.sessions).map((session) => renderFormat(format, session));
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(0);
  }

  process.stderr.write(`fake tmux: unsupported command ${command}\n`);
  process.exit(1);
}

main();
