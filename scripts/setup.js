#!/usr/bin/env node
'use strict';

// Cross-platform "one command" setup: finds whichever container engine is installed
// (Docker or Podman, either compose plugin or the standalone docker-compose) and runs
// the same `... compose up --build` the README documents, on Windows, macOS or Linux.
//
// Usage:
//   node scripts/setup.js
//   node scripts/setup.js API_PORT=3010 DB_PORT=5433
//   node scripts/setup.js --db-only          # hybrid: Postgres in a container, app run natively
//   node scripts/setup.js --db-only PORT=3010 DB_PORT=5433
//
// Plain key=value args (not shell env-var prefixes, which differ between bash, cmd
// and PowerShell) so port overrides work identically on every OS.

const net = require('net');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ON_WINDOWS = process.platform === 'win32';

const ENGINES = [
  { bin: 'docker', args: ['compose'] },
  { bin: 'podman', args: ['compose'] },
  { bin: 'docker-compose', args: [] },
];

function isAvailable(bin, args) {
  const probe = spawnSync(bin, [...args, 'version'], { stdio: 'ignore', shell: ON_WINDOWS });
  return !probe.error && probe.status === 0;
}

function findEngine() {
  return ENGINES.find((e) => isAvailable(e.bin, e.args)) ?? null;
}

// Returns which of API_PORT/DB_PORT the caller set explicitly, so a busy explicit
// port can still fail loudly instead of being silently swapped out.
function applyPortOverrides(args) {
  const explicit = new Set();
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) continue;
    const key = arg.slice(0, eq);
    process.env[key] = arg.slice(eq + 1);
    explicit.add(key);
  }
  return explicit;
}

// A free port binds and closes cleanly; a taken one fires 'error' (EADDRINUSE) instead.
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

// Port 0 asks the OS to hand back whatever it has free.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '0.0.0.0', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function resolvePort(name, defaultValue, wasExplicit) {
  const requested = Number(process.env[name] ?? defaultValue);
  if (await isPortFree(requested)) {
    process.env[name] = String(requested);
    return;
  }
  if (wasExplicit) {
    throw new Error(`${name}=${requested} is already in use. Try another: node scripts/setup.js ${name}=<port>`);
  }
  const picked = await findFreePort();
  console.log(`${name} ${requested} is busy (probably a local Postgres or another app); using ${picked} instead.`);
  process.env[name] = String(picked);
}

async function resolvePorts(explicit) {
  await resolvePort('API_PORT', 3000, explicit.has('API_PORT'));
  await resolvePort('DB_PORT', 5432, explicit.has('DB_PORT'));
}

// True once a TCP connection to `port` succeeds; Postgres only opens it once ready.
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`Postgres did not accept connections on port ${port} within ${timeoutMs}ms`));
        else setTimeout(attempt, 500);
      });
    })();
  });
}

// Removes this project's own containers/network from a previous run that never got
// stopped (a crash, a closed terminal, a Ctrl+C that didn't finish). Never touches the
// data volume, so a re-run resumes with the same seeded data. Best-effort: if there was
// nothing to clean up, `down` just exits 0 and does nothing.
function cleanupPreviousRun(engine) {
  return new Promise((resolve) => {
    console.log('Removing any containers left over from a previous run...');
    const proc = spawn(engine.bin, [...engine.args, 'down', '--remove-orphans'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: ON_WINDOWS,
    });
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });
}

// Runs one setup step to completion; a non-zero exit stops the whole script here.
function runStep(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: ON_WINDOWS });
  if (res.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed.`);
    process.exit(res.status ?? 1);
  }
}

// Hybrid mode: only `postgres` runs in a container; the app itself (build, migrate,
// seed, api, worker) is built and run natively on the host, no local Postgres install.
async function runDbOnly(engine, explicit) {
  await resolvePort('DB_PORT', 5432, explicit.has('DB_PORT'));
  await resolvePort('PORT', 3000, explicit.has('PORT'));
  const dbPort = process.env.DB_PORT;
  process.env.DATABASE_URL = `postgres://opps:opps@localhost:${dbPort}/opps`;
  process.env.TEST_DATABASE_URL = `postgres://opps:opps@localhost:${dbPort}/opps_test`;

  console.log(`Starting Postgres only, on port ${dbPort}...`);
  runStep(engine.bin, [...engine.args, 'up', '-d', 'postgres']);
  await waitForPort(Number(dbPort), 30_000);

  console.log('Postgres is ready. Building and seeding the app natively...');
  runStep('npm', ['ci']);
  runStep('npm', ['run', 'build']);
  runStep('npm', ['run', 'migrate']);
  runStep('npm', ['run', 'seed:small']);

  console.log(`Starting the API (port ${process.env.PORT}) and worker natively (Ctrl+C stops both; Postgres keeps running)...`);
  const api = spawn('node', ['dist/main.js'], { cwd: ROOT, stdio: 'inherit', shell: ON_WINDOWS });
  const worker = spawn('node', ['dist/worker.main.js'], { cwd: ROOT, stdio: 'inherit', shell: ON_WINDOWS });

  const stopAll = (signal) => {
    api.kill(signal);
    worker.kill(signal);
  };
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));

  let exited = 0;
  const onExit = (name) => (code) => {
    console.log(`${name} exited (${code}).`);
    if (exited === 0) stopAll('SIGTERM'); // one going down takes the other with it
    exited += 1;
    if (exited >= 2) process.exit(code ?? 0);
  };
  api.on('exit', onExit('api'));
  worker.on('exit', onExit('worker'));
}

async function main() {
  const engine = findEngine();
  if (!engine) {
    console.error(
      [
        'No container engine found (looked for `docker compose`, `podman compose`, `docker-compose`).',
        'Install Docker Desktop (docker.com) or Podman (podman.io), then re-run: node scripts/setup.js',
        'Or follow "Run without Docker" in README.md.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const dbOnly = rawArgs.includes('--db-only');
  const explicit = applyPortOverrides(rawArgs.filter((a) => a !== '--db-only'));
  await cleanupPreviousRun(engine);

  if (dbOnly) return runDbOnly(engine, explicit);

  await resolvePorts(explicit);
  console.log(`Using ${[engine.bin, ...engine.args].join(' ')} (API_PORT=${process.env.API_PORT}, DB_PORT=${process.env.DB_PORT})`);

  const child = spawn(engine.bin, [...engine.args, 'up', '--build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: ON_WINDOWS,
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 1));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
