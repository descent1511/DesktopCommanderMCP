import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = path.join(repoRoot, 'scripts/kubernetes-bridge.mjs');

const fakeKubectlSource = String.raw`#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify(args) + '\n');

if (args.includes('get') && args.includes('secret') && !args.includes('secretproviderclass')) {
  process.stderr.write('secrets "pim-api-prod" not found');
  process.exit(1);
}

if (args.includes('get') && args.includes('secretproviderclass')) {
  process.stdout.write(JSON.stringify({
    apiVersion: 'secrets-store.csi.x-k8s.io/v1',
    kind: 'SecretProviderClass',
    metadata: { name: 'pim-api-prod' },
    spec: {
      provider: 'aws',
      parameters: {
        objects: '- objectName: "prod/pim/api"\n  objectAlias: "pim_api_prod"\n',
      },
    },
  }));
  process.exit(0);
}

if (args.includes('get') && args.includes('pod')) {
  process.stdout.write(JSON.stringify({
    spec: {
      containers: [{
        name: 'pim-api',
        volumeMounts: [{ name: 'secret-volume', mountPath: '/mnt/pim-secrets', readOnly: true }],
      }],
      volumes: [{
        name: 'secret-volume',
        csi: {
          driver: 'secrets-store.csi.k8s.io',
          readOnly: true,
          volumeAttributes: { secretProviderClass: 'pim-api-prod' },
        },
      }],
    },
  }));
  process.exit(0);
}

const separator = args.indexOf('--');
if (separator >= 0 && args[separator + 1] === 'cat') {
  process.stdout.write('DB_HOST=prod-db.internal\nDB_PORT=5432\nDB_USER=phase1_reader\nDB_PASSWORD=CSI_PASS\nDB_NAME=pim\n');
  process.exit(0);
}

if (args.includes('psql')) {
  if (args.includes('SELECT 2 AS phase1_bridge_fallback')
    || args.includes('CREATE TABLE csi_backup_test AS SELECT 1')) {
    process.stderr.write('sh: exec: line 0: psql: not found');
    process.exit(127);
  }
  process.stdout.write('1\n');
  process.exit(0);
}

process.stderr.write('unexpected fake kubectl invocation');
process.exit(2);
`;

const fakeLocalPsqlSource = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('CREATE TABLE csi_backup_test AS SELECT 1')) process.stdout.write('CREATE TABLE AS\n');
else process.stdout.write('2\n');
`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForResponse(responsePath, child, stderr) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      return JSON.parse(readFileSync(responsePath, 'utf8'));
    } catch {
      if (child.exitCode !== null) break;
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for bridge response: ${stderr.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
}

async function sendRequest(dir, id, request, child, stderr) {
  const requestPath = path.join(dir, `request-${id}.json`);
  const responsePath = path.join(dir, `request-${id}.response.json`);
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  return waitForResponse(responsePath, child, stderr);
}

async function run() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dc-kubernetes-bridge-csi-'));
  const fakeKubectl = path.join(dir, 'fake-kubectl.mjs');
  const fakeLocalPsql = path.join(dir, 'fake-local-psql.mjs');
  const logPath = path.join(dir, 'kubectl.log');
  writeFileSync(fakeKubectl, fakeKubectlSource, { mode: 0o700 });
  chmodSync(fakeKubectl, 0o700);
  writeFileSync(fakeLocalPsql, fakeLocalPsqlSource, { mode: 0o700 });
  chmodSync(fakeLocalPsql, 0o700);
  writeFileSync(logPath, '', { mode: 0o600 });

  const stderr = [];
  const child = spawn(process.execPath, [bridgePath, '--dir', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      DESKTOP_COMMANDER_KUBECTL_BIN: fakeKubectl,
      DESKTOP_COMMANDER_DATABASE_PSQL_BIN: fakeLocalPsql,
      DESKTOP_COMMANDER_K8S_PROD_CONTEXT: 'cluster-prod',
      FAKE_KUBECTL_LOG: logPath,
    },
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    const response = await sendRequest(dir, 'csi', {
      mode: 'db_read',
      context: 'prod',
      namespace: 'default',
      pod: 'pim-api-abc',
      container: 'pim-api',
      engine: 'postgres',
      secret: 'pim-api-prod',
      query: 'SELECT 1',
      timeout_ms: 5000,
    }, child, stderr);

    assert.equal(response.ok, true, JSON.stringify(response));
    assert.match(response.output, /1/);
    assert.doesNotMatch(response.output, /CSI_PASS|phase1_reader|prod-db\.internal/);

    const fallback = await sendRequest(dir, 'csi-fallback', {
      mode: 'db_read',
      context: 'prod',
      namespace: 'default',
      pod: 'pim-api-abc',
      container: 'pim-api',
      engine: 'postgres',
      secret: 'pim-api-prod',
      query: 'SELECT 2 AS phase1_bridge_fallback',
      timeout_ms: 5000,
    }, child, stderr);
    assert.equal(fallback.ok, true, JSON.stringify(fallback));
    assert.match(fallback.command, /via host client/);
    assert.match(fallback.output, /2/);
    assert.doesNotMatch(fallback.output, /CSI_PASS|phase1_reader|prod-db\.internal/);

    const mutation = await sendRequest(dir, 'csi-mutation', {
      mode: 'db_mutate',
      context: 'prod',
      namespace: 'default',
      pod: 'pim-api-abc',
      container: 'pim-api',
      engine: 'postgres',
      secret: 'pim-api-prod',
      query: 'CREATE TABLE csi_backup_test AS SELECT 1',
      timeout_ms: 5000,
      confirm: true,
    }, child, stderr);
    assert.equal(mutation.ok, true, JSON.stringify(mutation));
    assert.match(mutation.command, /confirmed mutation via host client/);
    assert.match(mutation.output, /CREATE TABLE AS/);
    assert.doesNotMatch(mutation.output, /CSI_PASS|phase1_reader|prod-db\.internal/);

    const callsBeforeRejectedQuery = readFileSync(logPath, 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(callsBeforeRejectedQuery.some((args) => args.includes('secretproviderclass')));
    assert.ok(callsBeforeRejectedQuery.some((args) => args.includes('cat')));
    assert.ok(callsBeforeRejectedQuery.some((args) => args.includes('psql')));
    assert.ok(callsBeforeRejectedQuery.some((args) => args.includes('/mnt/pim-secrets/pim_api_prod')));

    const rejected = await sendRequest(dir, 'rejected', {
      mode: 'db_read',
      context: 'prod',
      namespace: 'default',
      pod: 'pim-api-abc',
      engine: 'postgres',
      secret: 'pim-api-prod',
      query: 'UPDATE users SET name = \'not allowed\'',
      timeout_ms: 5000,
    }, child, stderr);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.match(rejected.error, /read-only/);

    const callsAfterRejectedQuery = readFileSync(logPath, 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const newCalls = callsAfterRejectedQuery.slice(callsBeforeRejectedQuery.length);
    assert.ok(newCalls.every((args) => !args.includes('secret') && !args.includes('secretproviderclass') && !args.includes('exec')));
  } finally {
    await stopChild(child);
    rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
