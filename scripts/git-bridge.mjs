#!/usr/bin/env node

/*
 * Host-side Git bridge for the ChatGPT Web container.
 *
 * The MCP server only sees a short-lived file queue mounted into the
 * container. Git itself, repository metadata, hooks, SSH keys, and remotes
 * stay on the Mac. Every argument is passed as argv (never through a shell),
 * repositories are canonicalized and checked against an allowlist, and
 * mutation commands require an explicit confirmation flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_DIR = '/tmp/desktop-commander-git';
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ARGS = 80;

const READ_ACTIONS = new Set(['status', 'log', 'diff', 'branch', 'fetch']);
const MUTATE_ACTIONS = new Set(['add', 'commit', 'push', 'checkout', 'switch', 'merge']);

const BLOCKED_GLOBAL_ARGS = [
  '--config',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--upload-pack',
  '--work-tree',
  '--receive-pack',
  '--ssh-command',
  '--git-ssh',
];

const ACTION_BLOCKED_ARGS = {
  diff: [/^--(?:ext-diff|textconv|output)(?:=|$)/i, /^--no-index(?:=|$)/i],
  fetch: [/^(?:-f|--force(?:=|$)|--force-with-lease(?:=|$)|--refmap(?:=|$)|--server-option(?:=|$)|--stdin|--update-head-ok|--recurse-submodules(?:=|$))$/i],
  branch: [/^(?:-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--edit-description|--set-upstream-to|--unset-upstream)$/i],
  add: [/^--pathspec-from-file(?:=|$)/i, /^--pathspec-file-nul(?:=|$)/i, /^(?:-i|-p|--interactive|--patch)$/i],
  commit: [/^--no-verify$/i, /^(?:-F|--file|--template)(?:=|$)/i],
  push: [/^(?:-f|-d|--force(?:=|$)|--force-with-lease(?:=|$)|--delete(?:=|$)|--mirror(?:=|$)|--prune(?:=|$))$/i],
  checkout: [/^(?:-f|-B|--force(?:=|$)|--discard-changes(?:=|$)|--orphan(?:=|$))$/i],
  switch: [/^(?:-f|-C|--force(?:=|$)|--discard-changes(?:=|$)|--orphan(?:=|$)|--detach)$/i],
  merge: [/^--no-verify$/i, /^(?:--edit|-e|--file)(?:=|$)/i],
};

function parseArgs(argv) {
  const parsed = { dir: DEFAULT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dir') {
      parsed.dir = argv[index + 1];
      index += 1;
    }
  }
  if (!parsed.dir || parsed.dir.includes('\0')) throw new Error('A valid --dir path is required');
  return parsed;
}

function redactText(value) {
  return String(value)
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, '[REDACTED:private-key]')
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s"'`<>]+/gi, 'Authorization: Bearer [REDACTED:bearer-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED:bearer-token]')
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED:access-token]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd|token)\b\s*[:=]\s*)(["']?)([^\s,;}'"]+)(\2)/gi, '$1$2[REDACTED:secret]$4')
    .replace(/(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/)[^\s"'<>]+/gi, '$1[REDACTED:connection-string]')
    .replace(/(\b(?:https?|ssh|git):\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED:user]:[REDACTED:password]@');
}

function displayArgs(args) {
  return args.map((arg) => JSON.stringify(redactText(String(arg)))).join(' ');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isWithinPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathMappings() {
  return [
    {
      container: '/pim-ui',
      host: process.env.DESKTOP_COMMANDER_GIT_HOST_PIM_UI || '/Users/descent/Documents/AIRR/pim-ui',
    },
    {
      container: '/pim',
      host: process.env.DESKTOP_COMMANDER_GIT_HOST_PIM || '/Users/descent/Documents/AIRR/pim',
    },
    {
      container: '/airr',
      host: process.env.DESKTOP_COMMANDER_GIT_HOST_AIRR || '/Users/descent/Documents/AIRR',
    },
    {
      container: '/workspace',
      host: process.env.DESKTOP_COMMANDER_GIT_HOST_WORKSPACE || '/Users/descent/Projects',
    },
  ].map((mapping) => ({ ...mapping, host: path.resolve(mapping.host) }));
}

function allowedRoots() {
  const defaultRoots = [
    process.env.DESKTOP_COMMANDER_GIT_HOST_WORKSPACE || '/Users/descent/Projects',
    process.env.DESKTOP_COMMANDER_GIT_HOST_AIRR || '/Users/descent/Documents/AIRR',
  ];
  const configured = process.env.DESKTOP_COMMANDER_GIT_ALLOWED_ROOTS
    ? process.env.DESKTOP_COMMANDER_GIT_ALLOWED_ROOTS.split(path.delimiter)
    : defaultRoots;
  const roots = [];
  for (const root of configured) {
    if (!root || root.includes('\0')) continue;
    try {
      const canonical = fs.realpathSync(path.resolve(root));
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // The wrapper validates the normal mount roots before starting the bridge.
      // Ignore a stale optional root rather than broadening access.
    }
  }
  if (roots.length === 0) throw new Error('No existing Git allowlist root is configured');
  return roots;
}

function mapRepositoryPath(repository) {
  if (typeof repository !== 'string' || !repository || repository.includes('\0') || !path.posix.isAbsolute(repository)) {
    throw new Error('repo must be an absolute path visible to the container');
  }

  const normalized = path.posix.normalize(repository);
  for (const mapping of pathMappings()) {
    const prefix = mapping.container;
    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) continue;
    const relative = normalized.slice(prefix.length).replace(/^\/+/, '');
    if (relative === '..' || relative.startsWith('../')) {
      throw new Error(`repo escapes the mapped ${prefix} workspace`);
    }
    return { display: repository, hostPath: path.resolve(mapping.host, relative) };
  }

  // Host absolute paths are accepted for callers that already know the Mac
  // path, but the same allowlist check still applies below.
  return { display: repository, hostPath: path.resolve(repository) };
}

function gitPath() {
  const configured = process.env.DESKTOP_COMMANDER_GIT_BIN;
  if (configured) return configured;
  for (const candidate of ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'git';
}

function runProcess(command, args, timeoutMs, maxBytes = MAX_OUTPUT_BYTES, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    const append = (target, chunk) => {
      const text = chunk.toString();
      const remaining = maxBytes - Buffer.byteLength(target, 'utf8');
      if (remaining <= 0) {
        truncated = true;
        return target;
      }
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length <= remaining) return target + text;
      truncated = true;
      return target + bytes.subarray(0, remaining).toString('utf8');
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}${error.message}`, truncated, timedOut });
      }
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ exitCode, signal, stdout, stderr, truncated, timedOut });
      }
    });
  });
}

function validateStringArgs(args) {
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new Error(`args must contain at most ${MAX_ARGS} items`);
  if (args.some((arg) => typeof arg !== 'string' || arg.length < 1 || arg.length > 2048 || arg.includes('\0'))) {
    throw new Error('args contain an invalid value');
  }
}

function isBlockedGlobalArg(arg) {
  const lower = arg.toLowerCase();
  // Git accepts both -c key=value and -C path as global options. Reject the
  // attached forms too, so callers cannot escape the selected worktree or
  // inject a different config/hook/transport.
  if (lower.startsWith('-c') || lower.startsWith('-c=')) return true;
  return BLOCKED_GLOBAL_ARGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`));
}

function hasExplicitMessage(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-m' || arg === '--message') return index + 1 < args.length;
    if (/^(?:-m|--message=)/i.test(arg)) return true;
  }
  return false;
}

function hasCommitMessage(args) {
  return hasExplicitMessage(args) || args.includes('--no-edit');
}

function hasNonOptionArgument(args) {
  return args.some((arg) => arg !== '--' && !arg.startsWith('-'));
}

function validateActionArgs(action, args) {
  for (const arg of args) {
    if (isBlockedGlobalArg(arg)) {
      throw new Error(`Git argument ${redactText(arg)} is not allowed; repository and Git configuration are controlled by the local bridge`);
    }
    if ((ACTION_BLOCKED_ARGS[action] || []).some((pattern) => pattern.test(arg))) {
      throw new Error(`Git ${action} argument ${redactText(arg)} is blocked by the local safety policy`);
    }
  }

  if (action === 'checkout' && args.includes('--')) {
    throw new Error('checkout path restoration is not available through this bridge; use a branch checkout only');
  }
  if (action === 'add' && args.length === 0) throw new Error('git add requires a pathspec or -A/-u option');
  if ((action === 'checkout' || action === 'switch') && !hasNonOptionArgument(args)) {
    throw new Error(`git ${action} requires a branch or target`);
  }
  if (action === 'merge' && !hasNonOptionArgument(args)) throw new Error('git merge requires a branch or target');
  if (action === 'commit' && !hasCommitMessage(args)) {
    throw new Error('git commit requires -m/--message or --no-edit so the host bridge never opens an interactive editor');
  }
  if (action === 'merge' && !args.includes('--no-edit') && !hasExplicitMessage(args)) {
    throw new Error('git merge requires --no-edit or an explicit -m/--message so the host bridge never opens an interactive editor');
  }
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid Git bridge request');
  if (request.mode !== 'read' && request.mode !== 'mutate') throw new Error('mode must be read or mutate');
  const actionSet = request.mode === 'read' ? READ_ACTIONS : MUTATE_ACTIONS;
  if (typeof request.action !== 'string' || !actionSet.has(request.action)) {
    throw new Error(`action is not available through git_${request.mode}`);
  }
  validateStringArgs(request.args || []);
  if (!Number.isInteger(request.timeout_ms) || request.timeout_ms < 1_000 || request.timeout_ms > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be between 1000 and ${MAX_TIMEOUT_MS}`);
  }
  if (request.mode === 'mutate' && request.confirm !== true) {
    throw new Error('Confirmation required: ask the user to confirm this Git change, then retry with confirm=true');
  }
  if (request.mode === 'read' && request.action === 'fetch' && request.confirm !== true) {
    throw new Error('Confirmation required: git fetch updates local remote-tracking refs, then retry with confirm=true');
  }
  validateActionArgs(request.action, request.args || []);
}

async function resolveRepository(repository) {
  const mapped = mapRepositoryPath(repository);
  let candidate;
  try {
    if (!fs.statSync(mapped.hostPath).isDirectory()) throw new Error('not a directory');
    candidate = fs.realpathSync(mapped.hostPath);
  } catch {
    throw new Error(`repo is not an existing directory: ${redactText(repository)}`);
  }

  const roots = allowedRoots();
  if (!roots.some((root) => isWithinPath(root, candidate))) {
    throw new Error(`repo is outside the local Git allowlist: ${redactText(repository)}`);
  }

  const probe = await runProcess(gitPath(), ['-C', candidate, 'rev-parse', '--show-toplevel'], 10_000, 128 * 1024, candidate);
  if (probe.exitCode !== 0 || probe.timedOut) {
    throw new Error(`repo is not a Git worktree: ${redactText(probe.stderr || repository)}`);
  }
  const rootText = probe.stdout.trim().split(/\r?\n/)[0];
  if (!rootText) throw new Error(`Git did not return a worktree root for ${redactText(repository)}`);
  let root;
  try {
    root = fs.realpathSync(path.resolve(rootText));
  } catch {
    throw new Error(`Git returned an invalid worktree root for ${redactText(repository)}`);
  }
  if (!roots.some((allowed) => isWithinPath(allowed, root))) {
    throw new Error('The canonical Git worktree root is outside the local Git allowlist');
  }
  return { root, display: mapped.display };
}

function commandArgs(action, args) {
  switch (action) {
    case 'status': return ['status', '--short', '--branch', ...args];
    case 'log': return ['log', '--oneline', '--decorate', '-n', '30', ...args];
    case 'diff': return ['diff', '--no-ext-diff', '--no-textconv', ...args];
    case 'branch': return ['branch', '--list', '--all', '--verbose', ...args];
    case 'fetch': return args.length > 0 ? ['fetch', '--prune', '--no-recurse-submodules', ...args] : ['fetch', '--prune', '--no-recurse-submodules', '--all'];
    case 'add': return ['add', ...args];
    case 'commit': return ['commit', ...args];
    case 'push': return ['push', ...args];
    case 'checkout': return ['checkout', ...args];
    case 'switch': return ['switch', ...args];
    case 'merge': return ['merge', ...args];
    default: throw new Error(`Unsupported Git action: ${action}`);
  }
}

function formatResult(result, request, repository, command) {
  const outputParts = [];
  if (result.stdout) outputParts.push(result.stdout);
  if (result.stderr) outputParts.push(`[stderr]\n${result.stderr}`);
  let output = outputParts.join(outputParts.length > 1 ? '\n' : '');
  if (!output) output = result.exitCode === 0 ? 'Git operation completed successfully with no output.' : 'Git operation returned no output.';
  if (result.truncated) output += '\n[output truncated]';
  if (result.timedOut) output += `\n[operation timed out after ${request.timeout_ms}ms]`;
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    repo: repository.display,
    action: request.action,
    command,
    exitCode: result.exitCode,
    signal: result.signal,
    output: redactText(output),
    timedOut: result.timedOut,
  };
}

async function handleRequest(request) {
  validateRequest(request);
  const repository = await resolveRepository(request.repo);
  const args = commandArgs(request.action, request.args || []);
  const result = await runProcess(gitPath(), args, request.timeout_ms, MAX_OUTPUT_BYTES, repository.root);
  const command = `git -C ${JSON.stringify(redactText(repository.display))} ${displayArgs(args)}`;
  return formatResult(result, request, repository, command);
}

async function processQueueOnce(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const requests = entries
    .filter((entry) => entry.isFile() && /^request-[A-Za-z0-9_-]+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, 16);

  for (const name of requests) {
    const requestPath = path.join(dir, name);
    const responsePath = path.join(dir, name.replace(/\.json$/, '.response.json'));
    const tempResponsePath = `${responsePath}.tmp`;
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(requestPath, 'utf8'));
    } catch (error) {
      payload = { ok: false, error: `Invalid Git bridge request: ${error instanceof Error ? error.message : String(error)}` };
    }

    let response;
    if (payload?.ok === false && payload.error) {
      response = payload;
    } else {
      try {
        response = await handleRequest(payload);
      } catch (error) {
        response = { ok: false, error: redactText(error instanceof Error ? error.message : String(error)) };
      }
    }

    try {
      await fs.promises.writeFile(tempResponsePath, `${JSON.stringify(response)}\n`, { mode: 0o600 });
      await fs.promises.rename(tempResponsePath, responsePath);
      await fs.promises.unlink(requestPath).catch(() => {});
    } catch {
      await fs.promises.unlink(tempResponsePath).catch(() => {});
    }
  }
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  if (!path.isAbsolute(dir) || dir === '/' || dir === '.' || dir === '..') {
    throw new Error('The Git bridge directory must be a specific absolute path');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort; the wrapper owns the directory */ }

  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    try {
      await processQueueOnce(dir);
    } catch (error) {
      if (!stopping && error?.code !== 'ENOENT') await sleep(100);
    }
    if (!stopping) await sleep(25);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
