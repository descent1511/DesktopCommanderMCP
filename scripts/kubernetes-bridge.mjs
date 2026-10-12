#!/usr/bin/env node

/*
 * Host-side Kubernetes bridge for the ChatGPT Web container.
 *
 * The MCP server never receives the kubeconfig or cloud credentials.  It only
 * gets a short-lived file-queue directory mounted into the container.  This
 * avoids Docker Desktop's limitation around bind-mounting Unix sockets on
 * macOS.  The process resolves the explicit uat/prod alias, invokes kubectl
 * with argv (never a shell), and returns bounded, redacted output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_DIR = '/tmp/desktop-commander-kubernetes';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ARGS = 80;

const READ_COMMANDS = new Set([
  'api-resources',
  'api-versions',
  'auth',
  'cluster-info',
  'describe',
  'events',
  'explain',
  'get',
  'logs',
  'top',
  'version',
]);

const DATABASE_ENGINES = new Set(['postgres', 'mysql', 'redis']);
const DATABASE_NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const DEFAULT_DATABASE_PORTS = { postgres: 5432, mysql: 3306, redis: 6379 };
const DATABASE_READ_SQL = /^(select|show|describe|desc|explain)\b/i;
const REDIS_READ_COMMANDS = new Set([
  'COMMAND', 'DBSIZE', 'ECHO', 'EXISTS', 'GET', 'HGET', 'HGETALL', 'HEXISTS', 'HLEN',
  'HMGET', 'HSCAN', 'INFO', 'LLEN', 'LINDEX', 'LRANGE', 'MEMORY', 'MGET', 'OBJECT',
  'PING', 'PTTL', 'RANDOMKEY', 'SCAN', 'SCARD', 'SDIFF', 'SISMEMBER', 'SMEMBERS',
  'SSCAN', 'STRLEN', 'TIME', 'TTL', 'TYPE', 'XLEN', 'XRANGE', 'XREAD', 'ZCARD',
  'ZRANGE', 'ZRANK', 'ZSCAN',
]);

const BLOCKED_GLOBAL_FLAGS = [
  '--as',
  '--as-group',
  '--as-uid',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--context',
  '--embed-certs',
  '--kubeconfig',
  '--password',
  '--server',
  '--token',
  '--user',
  '--username',
];

function parseArgs(argv) {
  const parsed = { dir: DEFAULT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dir') {
      parsed.dir = argv[index + 1];
      index += 1;
    }
  }
  if (!parsed.dir || parsed.dir.includes('\0')) {
    throw new Error('A valid --dir path is required');
  }
  return parsed;
}

function redactText(value) {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, '[REDACTED:private-key]')
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s"'`<>]+/gi, 'Authorization: Bearer [REDACTED:bearer-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED:bearer-token]')
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED:access-token]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd|token)\b\s*[:=]\s*(["'`]?)[^\s,;}'"`]+\1/gi, '$&'.replace(/[^:]*$/, '[REDACTED:secret]'))
    .replace(/(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/)[^\s"'<>]+/gi, '$1[REDACTED:connection-string]');
}

function redactKubernetesSecrets(value) {
  let text = redactText(value);

  // JSON Secret output commonly contains base64 data that does not look like
  // a token.  Replace values under Secret.data/stringData before returning it.
  try {
    const parsed = JSON.parse(text);
    const scrub = (node) => {
      if (Array.isArray(node)) return node.map(scrub);
      if (!node || typeof node !== 'object') return node;
      const copy = {};
      for (const [key, child] of Object.entries(node)) {
        if ((key === 'data' || key === 'stringData') && child && typeof child === 'object' && !Array.isArray(child)) {
          copy[key] = Object.fromEntries(Object.keys(child).map((entry) => [entry, '[REDACTED:kubernetes-secret-data]']));
        } else {
          copy[key] = scrub(child);
        }
      }
      return copy;
    };
    return JSON.stringify(scrub(parsed), null, 2);
  } catch {
    // YAML/table output is handled conservatively below.  The command-level
    // check in isSecretQuery protects jsonpath/raw secret values as well.
  }

  const lines = text.split('\n');
  let inSecretData = false;
  let dataIndent = 0;
  return lines.map((line) => {
    const dataMatch = line.match(/^(\s*)(?:data|stringData):\s*$/);
    if (dataMatch) {
      inSecretData = true;
      dataIndent = dataMatch[1].length;
      return line;
    }
    if (inSecretData) {
      const indent = line.match(/^(\s*)/)[1].length;
      if (line.trim() !== '' && indent <= dataIndent) inSecretData = false;
      else if (inSecretData && line.trim() !== '') {
        const key = line.match(/^(\s+[^:#]+:\s*)(.*)$/);
        if (key) return `${key[1]}[REDACTED:kubernetes-secret-data]`;
      }
    }
    return line;
  }).join('\n');
}

function isSecretQuery(args) {
  const text = args.join(' ').toLowerCase();
  return /(?:^|[\s/])secret(?:s)?(?:[\s/]|$)/.test(text) && /(?:-o|--output)(?:=|\s+)(?:jsonpath|json|yaml|yml|go-template|go-template-file)/.test(text);
}

function displayArgs(args) {
  return args.map((arg) => redactText(String(arg))).join(' ');
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid bridge request');
  if (!['uat', 'prod'].includes(request.context)) throw new Error('context must be "uat" or "prod"');
  if (!['read', 'mutate', 'db_read', 'db_mutate'].includes(request.mode)) throw new Error('mode is invalid');

  if (request.mode === 'db_read' || request.mode === 'db_mutate') {
    validateDatabaseRequest(request);
    if (request.mode === 'db_mutate' && request.confirm !== true) {
      throw new Error('Confirmation required: ask the user to confirm this database change, then retry with confirm=true');
    }
    return;
  }

  if (!Array.isArray(request.args) || request.args.length < 1 || request.args.length > MAX_ARGS) {
    throw new Error(`args must contain 1-${MAX_ARGS} items`);
  }
  if (request.args.some((arg) => typeof arg !== 'string' || arg.length < 1 || arg.length > 2048 || arg.includes('\0'))) {
    throw new Error('args contain an invalid value');
  }
  if (request.mode === 'mutate' && request.confirm !== true) {
    throw new Error('Confirmation required: ask the user to confirm this Kubernetes change, then retry with confirm=true');
  }

  for (const arg of request.args) {
    const lower = arg.toLowerCase();
    if (BLOCKED_GLOBAL_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) {
      throw new Error(`Argument ${arg} is not allowed; context and credentials are controlled by the local bridge`);
    }
  }

  const command = request.args[0].toLowerCase();
  if (command === 'config' || command === 'plugin' || command === 'completion') {
    throw new Error(`kubectl ${command} is not available through this bridge`);
  }
  if (request.mode === 'read' && !READ_COMMANDS.has(command)) {
    throw new Error(`kubectl ${command} is not read-only; use the confirmation-protected mutation tool`);
  }
}

function validateDatabaseRequest(request) {
  if (request.namespace === undefined) request.namespace = 'default';
  const keyDefaults = { username_key: 'username', password_key: 'password', database_key: 'database', host_key: 'host', port_key: 'port' };
  for (const [field, value] of Object.entries(keyDefaults)) {
    if (request[field] === undefined) request[field] = value;
  }
  if (!DATABASE_ENGINES.has(request.engine)) throw new Error('engine must be postgres, mysql, or redis');
  for (const field of ['namespace', 'pod', 'secret']) {
    if (typeof request[field] !== 'string' || !DATABASE_NAME_PATTERN.test(request[field])) {
      throw new Error(`${field} must be a Kubernetes resource name`);
    }
  }
  if (request.container !== undefined && (typeof request.container !== 'string' || !DATABASE_NAME_PATTERN.test(request.container))) {
    throw new Error('container must be a Kubernetes resource name');
  }
  if (typeof request.query !== 'string' || request.query.length < 1 || request.query.length > 100_000 || request.query.includes('\0')) {
    throw new Error('query must be a non-empty string of at most 100000 characters');
  }
  for (const field of ['username_key', 'password_key', 'database_key', 'host_key', 'port_key']) {
    if (typeof request[field] !== 'string' || request[field].length > 128 || request[field].includes('\0')) {
      throw new Error(`${field} is invalid`);
    }
  }
  if (request.host !== undefined && (typeof request.host !== 'string' || request.host.length < 1 || request.host.length > 253 || request.host.includes('\0'))) {
    throw new Error('host is invalid');
  }
  if (request.port !== undefined && (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535)) {
    throw new Error('port must be between 1 and 65535');
  }
}

function kubectlPath() {
  const configured = process.env.DESKTOP_COMMANDER_KUBECTL_BIN;
  if (configured) return configured;
  for (const candidate of ['/usr/local/bin/kubectl', '/opt/homebrew/bin/kubectl']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'kubectl';
}

function runProcess(command, args, timeoutMs, maxBytes = MAX_OUTPUT_BYTES, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    if (input !== undefined && child.stdin) child.stdin.end(input);
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

async function resolveContext(alias) {
  const envName = `DESKTOP_COMMANDER_K8S_${alias.toUpperCase()}_CONTEXT`;
  if (process.env[envName]) return process.env[envName];

  const result = await runProcess(kubectlPath(), ['config', 'get-contexts', '-o', 'name'], 10_000, 128 * 1024);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to discover Kubernetes contexts: ${redactText(result.stderr || 'kubectl config failed')}`);
  }
  const names = result.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const suffix = new RegExp(`(?:^|[-_/])${alias}$`, 'i');
  const matches = names.filter((name) => suffix.test(name));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No Kubernetes context ending in -${alias} was found`);
  throw new Error(`Multiple Kubernetes contexts match ${alias}; set ${envName} to the exact context name`);
}

function decodeSecretValue(value) {
  if (typeof value !== 'string') return undefined;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function firstSecretValue(secretDocument, requestedKey, aliases) {
  if (requestedKey === '') return undefined;
  const data = secretDocument?.data && typeof secretDocument.data === 'object' ? secretDocument.data : {};
  const stringData = secretDocument?.stringData && typeof secretDocument.stringData === 'object' ? secretDocument.stringData : {};
  const keys = [...new Set([requestedKey, ...aliases].filter(Boolean))];
  for (const key of keys) {
    if (typeof data[key] === 'string') return decodeSecretValue(data[key]);
    if (typeof stringData[key] === 'string') return stringData[key];
  }
  return undefined;
}

async function loadDatabaseCredentials(context, request, timeoutMs) {
  const result = await runProcess(kubectlPath(), [
    '--context', context,
    '--namespace', request.namespace,
    'get', 'secret', request.secret,
    '--output', 'json',
  ], Math.min(timeoutMs, 20_000), 512 * 1024);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to read Kubernetes Secret ${request.secret}: ${redactText(result.stderr || 'kubectl get secret failed')}`);
  }

  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Kubernetes Secret ${request.secret} returned invalid JSON`);
  }

  const username = firstSecretValue(document, request.username_key, [
    'username', 'user', 'postgres-user', 'postgres_username', 'POSTGRES_USER', 'MYSQL_USER', 'DB_USER',
  ]);
  const password = firstSecretValue(document, request.password_key, [
    'password', 'passwd', 'redis-password', 'postgres-password', 'postgres_password', 'POSTGRES_PASSWORD',
    'MYSQL_PASSWORD', 'DB_PASSWORD',
  ]);
  const database = firstSecretValue(document, request.database_key, [
    'database', 'dbname', 'db-name', 'postgres-db', 'postgres_database', 'POSTGRES_DB', 'MYSQL_DATABASE', 'DB_NAME',
  ]);
  const secretHost = firstSecretValue(document, request.host_key, [
    'host', 'hostname', 'address', ...(request.engine === 'redis' ? ['REDIS_HOST'] : ['DB_HOST', 'POSTGRES_HOST', 'MYSQL_HOST']),
  ]);
  const secretPort = firstSecretValue(document, request.port_key, [
    'port', 'db-port', ...(request.engine === 'redis' ? ['REDIS_PORT'] : ['DB_PORT', 'POSTGRES_PORT', 'MYSQL_PORT']),
  ]);

  const port = request.port ?? (secretPort && /^\d+$/.test(secretPort) ? Number(secretPort) : DEFAULT_DATABASE_PORTS[request.engine]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Database port from the request or Secret is invalid');

  return {
    username,
    password,
    database,
    host: request.host || secretHost || '127.0.0.1',
    port,
  };
}

function databaseExecPrefix(context, request, withStdin) {
  const args = ['--context', context, '--namespace', request.namespace, 'exec'];
  if (withStdin) args.push('--stdin');
  args.push(request.pod);
  if (request.container) args.push('--container', request.container);
  args.push('--');
  return args;
}

function credentialShell(variable) {
  return 'set -eu; IFS= read -r encoded; value="$(printf "%s" "$encoded" | base64 -d 2>/dev/null || printf "%s" "$encoded" | base64 --decode)"; export '
    + variable
    + '="$value"; unset encoded value; exec "$@"';
}

function parseRedisCommand(value) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) { tokens.push(token); token = ''; }
    } else {
      token += character;
    }
  }
  if (escaped || quote) throw new Error('Redis query has an unterminated quote or escape');
  if (token) tokens.push(token);
  if (tokens.length === 0) throw new Error('Redis query is empty');
  return tokens;
}

function databaseReadQueryAllowed(engine, query) {
  const normalized = query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();
  if (engine === 'redis') {
    const tokens = parseRedisCommand(normalized);
    const command = tokens[0].toUpperCase();
    if (!REDIS_READ_COMMANDS.has(command)) return false;
    if (command === 'CLIENT' && !['LIST', 'INFO', 'GETNAME', 'ID', 'HELP'].includes((tokens[1] || '').toUpperCase())) return false;
    if (command === 'MEMORY' && !['USAGE', 'STATS', 'DOCTOR', 'HELP'].includes((tokens[1] || '').toUpperCase())) return false;
    return true;
  }
  // Only one clearly read-only statement is allowed. This rejects multiple
  // statements and SELECT ... INTO forms that can write to disk or lock data.
  const statement = normalized.replace(/;\s*$/, '').trim();
  return DATABASE_READ_SQL.test(statement)
    && !statement.includes(';')
    && !/\binto\s+(outfile|dumpfile)\b/i.test(statement)
    && !/\bfor\s+(update|share)\b/i.test(statement);
}

function redactDatabaseOutput(value, credentials) {
  let output = redactText(value);
  for (const secret of [credentials.password, credentials.username]) {
    if (typeof secret === 'string' && secret.length >= 4) output = output.split(secret).join('[REDACTED:database-credential]');
  }
  return output;
}

async function handleDatabaseRequest(request, context, timeoutMs) {
  const credentials = await loadDatabaseCredentials(context, request, timeoutMs);
  if (request.mode === 'db_read' && !databaseReadQueryAllowed(request.engine, request.query)) {
    throw new Error('This database operation is not classified as read-only; use the confirmation-protected database_mutate tool');
  }

  const execArgs = databaseExecPrefix(context, request, credentials.password !== undefined);
  let clientArgs;
  let credentialVariable;
  if (request.engine === 'postgres') {
    credentialVariable = 'PGPASSWORD';
    if (credentials.username) clientArgs = ['psql', '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '\\t', '--host', credentials.host, '--port', String(credentials.port), '--username', credentials.username];
    else clientArgs = ['psql', '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '\\t', '--host', credentials.host, '--port', String(credentials.port)];
    if (credentials.database) clientArgs.push('--dbname', credentials.database);
    clientArgs.push('--command', request.query);
  } else if (request.engine === 'mysql') {
    credentialVariable = 'MYSQL_PWD';
    clientArgs = ['mysql', '--batch', '--raw', '--skip-column-names', '--protocol=TCP', '--host', credentials.host, '--port', String(credentials.port)];
    if (credentials.username) clientArgs.push('--user', credentials.username);
    if (credentials.database) clientArgs.push('--database', credentials.database);
    clientArgs.push('--execute', request.query);
  } else {
    credentialVariable = 'REDISCLI_AUTH';
    clientArgs = ['redis-cli', '--raw', '--no-auth-warning', '-h', credentials.host, '-p', String(credentials.port)];
    clientArgs.push(...parseRedisCommand(request.query));
  }

  // Send the credential over kubectl exec's stdin as base64 instead of putting
  // it in kubectl's argv or the host process environment. The query itself is
  // passed as argv to the database client; no shell interpolation is used.
  const command = credentials.password !== undefined
    ? [...execArgs, 'sh', '-c', credentialShell(credentialVariable), 'sh', ...clientArgs]
    : [...execArgs, ...clientArgs];
  const credentialInput = credentials.password !== undefined
    ? `${Buffer.from(credentials.password, 'utf8').toString('base64')}\n`
    : undefined;
  const result = await runProcess(kubectlPath(), command, timeoutMs, MAX_OUTPUT_BYTES, credentialInput);
  const outputParts = [];
  if (result.stdout) outputParts.push(result.stdout);
  if (result.stderr) outputParts.push(`[stderr]\n${result.stderr}`);
  let output = outputParts.join(outputParts.length > 1 ? '\n' : '');
  if (!output) output = result.exitCode === 0 ? 'Database operation completed successfully with no output.' : 'Database operation returned no output.';
  if (result.truncated) output += '\n[output truncated]';
  if (result.timedOut) output += `\n[operation timed out after ${timeoutMs}ms]`;

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    context,
    command: `database ${request.engine} operation in pod ${request.pod}`,
    exitCode: result.exitCode,
    signal: result.signal,
    output: redactDatabaseOutput(output, credentials),
    timedOut: result.timedOut,
  };
}

async function handleRequest(request) {
  validateRequest(request);
  const context = await resolveContext(request.context);
  const timeoutMs = Math.min(Math.max(Number(request.timeout_ms) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  if (request.mode === 'db_read' || request.mode === 'db_mutate') {
    return handleDatabaseRequest(request, context, timeoutMs);
  }
  const result = await runProcess(kubectlPath(), ['--context', context, ...request.args], timeoutMs);
  const outputParts = [];
  if (result.stdout) outputParts.push(result.stdout);
  if (result.stderr) outputParts.push(`[stderr]\n${result.stderr}`);
  let output = outputParts.join(outputParts.length > 1 ? '\n' : '');
  if (!output) output = result.exitCode === 0 ? 'Command completed successfully with no output.' : 'Command returned no output.';
  if (result.truncated) output += '\n[output truncated]';
  if (result.timedOut) output += `\n[command timed out after ${timeoutMs}ms]`;
  if (isSecretQuery(request.args)) output = '[REDACTED:kubernetes-secret-data]';
  else output = redactKubernetesSecrets(output);

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    context,
    command: `kubectl ${displayArgs(request.args)}`,
    exitCode: result.exitCode,
    signal: result.signal,
    output,
    timedOut: result.timedOut,
  };
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
      payload = { ok: false, error: `Invalid Kubernetes bridge request: ${error instanceof Error ? error.message : String(error)}` };
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

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  if (!path.isAbsolute(dir) || dir === '/' || dir === '.' || dir === '..') {
    throw new Error('The Kubernetes bridge directory must be a specific absolute path');
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
      // The wrapper may remove the directory during shutdown. Keep the host
      // process quiet; individual request failures are returned to the client.
      if (!stopping && error?.code !== 'ENOENT') await waitMs(100);
    }
    if (!stopping) await waitMs(25);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
