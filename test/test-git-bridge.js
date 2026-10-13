import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = path.join(repoRoot, 'scripts/git-bridge.mjs');

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
  throw new Error(`Timed out waiting for Git bridge response: ${stderr.join('')}`);
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dc-git-bridge-'));
  const repo = path.join(dir, 'repo');
  const queue = path.join(dir, 'queue');
  const fakeHome = path.join(dir, 'home');
  const git = (args) => execFileAsync('git', ['-C', repo, ...args]);
  const stderr = [];

  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(queue, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    await execFileAsync('git', ['-C', repo, 'init', '-q']);
    await git(['config', 'user.name', 'Git bridge test']);
    await git(['config', 'user.email', 'git-bridge-test@example.invalid']);
    writeFileSync(path.join(repo, 'README.md'), 'bridge test\n');

    const child = spawn(process.execPath, [bridgePath, '--dir', queue], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HOME: fakeHome,
        DESKTOP_COMMANDER_GIT_ALLOWED_ROOTS: repo,
        DESKTOP_COMMANDER_GIT_HOST_WORKSPACE: repo,
        DESKTOP_COMMANDER_GIT_HOST_AIRR: repo,
        DESKTOP_COMMANDER_GIT_HOST_PIM: repo,
        DESKTOP_COMMANDER_GIT_HOST_PIM_UI: repo,
      },
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

    try {
      const status = await sendRequest(queue, 'status', {
        mode: 'read', repo: '/workspace', action: 'status', args: [], timeout_ms: 5000,
      }, child, stderr);
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.match(status.output, /README\.md/);

      const noConfirmation = await sendRequest(queue, 'no-confirm', {
        mode: 'mutate', repo: '/workspace', action: 'add', args: ['README.md'], timeout_ms: 5000, confirm: false,
      }, child, stderr);
      assert.equal(noConfirmation.ok, false, JSON.stringify(noConfirmation));
      assert.match(noConfirmation.error, /Confirmation required/);

      const forcePush = await sendRequest(queue, 'force-push', {
        mode: 'mutate', repo: '/workspace', action: 'push', args: ['--force'], timeout_ms: 5000, confirm: true,
      }, child, stderr);
      assert.equal(forcePush.ok, false, JSON.stringify(forcePush));
      assert.match(forcePush.error, /blocked/);

      const add = await sendRequest(queue, 'add', {
        mode: 'mutate', repo: '/workspace', action: 'add', args: ['README.md'], timeout_ms: 5000, confirm: true,
      }, child, stderr);
      assert.equal(add.ok, true, JSON.stringify(add));

      const commit = await sendRequest(queue, 'commit', {
        mode: 'mutate', repo: '/workspace', action: 'commit', args: ['-m', 'test Git bridge'], timeout_ms: 5000, confirm: true,
      }, child, stderr);
      assert.equal(commit.ok, true, JSON.stringify(commit));
    } finally {
      await stopChild(child);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
