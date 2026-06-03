#!/usr/bin/env node

const { spawn } = require('child_process');

const children = new Map();
let shuttingDown = false;

function now() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`${now()} INFO - ${message}`);
}

function startProcess(name, args) {
  log(`Starting ${name}: node ${args.join(' ')}`);
  const child = spawn('node', args, {
    stdio: 'inherit',
    env: process.env,
  });

  children.set(name, child);

  child.on('error', (error) => {
    console.error(`${now()} ERROR - ${name} failed to start: ${error && error.message ? error.message : String(error)}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    children.delete(name);
    const exitCode = code === null ? 1 : code;
    const detail = signal ? `signal ${signal}` : `code ${exitCode}`;
    console.error(`${now()} ERROR - ${name} exited with ${detail}`);
    if (!shuttingDown) shutdown(exitCode || 1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Stopping child processes (exitCode=${exitCode})`);

  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }

  setTimeout(() => {
    for (const child of children.values()) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 8000).unref();

  if (children.size === 0) process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

startProcess('scheduler', ['scripts/scheduler.js']);
startProcess('manual-web', ['scripts/manual-web.js']);
