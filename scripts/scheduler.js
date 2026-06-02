#!/usr/bin/env node

const dotenv = require('dotenv');
const { spawn } = require('child_process');

dotenv.config({ quiet: true });

function toInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : Math.trunc(parsed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSyncOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/sync-jellyfin.js'], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sync-jellyfin.js exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const sleepSeconds = Math.max(1, toInt(process.env.SLEEP_SECONDS, 86400));
  console.log(`${new Date().toISOString()} INFO - Scheduler iniciado (sleep=${sleepSeconds}s)`);

  while (true) {
    const startedAt = Date.now();
    console.log(`${new Date().toISOString()} INFO - Ejecutando ciclo de sync`);

    try {
      await runSyncOnce();
      const tookMs = Date.now() - startedAt;
      console.log(`${new Date().toISOString()} INFO - Ciclo completado en ${tookMs}ms`);
    } catch (error) {
      console.error(`${new Date().toISOString()} ERROR - Ciclo con error: ${error && error.message ? error.message : String(error)}`);
    }

    await sleep(sleepSeconds * 1000);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${new Date().toISOString()} ERROR - Scheduler falló: ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}
