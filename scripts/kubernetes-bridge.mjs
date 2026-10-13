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
const CSI_SECRETS_STORE_DRIVER = 'secrets-store.csi.k8s.io';
const MAX_CSI_SECRET_FILE_BYTES = 512 * 1024;
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

function runProcess(command, args, timeoutMs, maxBytes = MAX_OUTPUT_BYTES, input, environment) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: environment ? { ...process.env, ...environment } : process.env,
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

function firstMapValue(values, requestedKey, aliases) {
  if (requestedKey === '') return undefined;
  const keys = [...new Set([requestedKey, ...aliases].filter(Boolean))];
  for (const key of keys) {
    const value = values?.[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }

  // Dotenv files are conventionally uppercase, while the request defaults
  // follow Kubernetes Secret key names.  Allow case-insensitive matching only
  // after exact keys have been tried so an explicit key always wins.
  const entries = values && typeof values === 'object' ? Object.entries(values) : [];
  for (const key of keys) {
    const match = entries.find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    if (match && (typeof match[1] === 'string' || typeof match[1] === 'number')) return String(match[1]);
  }
  return undefined;
}

function databaseCredentialAliases(request) {
  const isRedis = request.engine === 'redis';
  return {
    username: [
      'username', 'user', 'postgres-user', 'postgres_username', 'POSTGRES_USER', 'MYSQL_USER', 'DB_USER',
      'AFN_DB_USER', 'OMS_DB_USER', 'PROD_READ_DB_USER', 'SS_USER', 'SINGLESTORE_DB_USER',
    ],
    password: [
      'password', 'passwd', 'redis-password', 'postgres-password', 'postgres_password', 'POSTGRES_PASSWORD',
      'MYSQL_PASSWORD', 'DB_PASSWORD', 'AFN_DB_PASSWORD', 'OMS_DB_PASSWORD', 'PROD_READ_DB_PASSWORD',
      'SS_PASSWORD', 'SINGLESTORE_DB_PASSWORD', 'REDIS_PASSWORD',
    ],
    database: [
      'database', 'dbname', 'db-name', 'postgres-db', 'postgres_database', 'POSTGRES_DB', 'MYSQL_DATABASE', 'DB_NAME',
      'AFN_DB_NAME', 'OMS_DB_NAME', 'PROD_READ_DB_NAME', 'SS_DB', 'SINGLESTORE_DB_NAME', 'REDIS_DB',
    ],
    host: [
      'host', 'hostname', 'address', 'DB_HOST', 'POSTGRES_HOST', 'MYSQL_HOST', 'AFN_DB_HOST', 'OMS_DB_HOST',
      'PROD_READ_DB_HOST', 'SS_HOST', 'SINGLESTORE_DB_HOST', ...(isRedis ? ['REDIS_HOST'] : []),
    ],
    port: [
      'port', 'db-port', 'DB_PORT', 'POSTGRES_PORT', 'MYSQL_PORT', 'AFN_DB_PORT', 'OMS_DB_PORT',
      'PROD_READ_DB_PORT', 'SS_PORT', 'SINGLESTORE_DB_PORT', ...(isRedis ? ['REDIS_PORT'] : []),
    ],
    sslmode: [
      'sslmode', 'SSL_MODE', 'DB_SSLMODE', 'POSTGRES_SSLMODE', 'AFN_DB_SSLMODE', 'PROD_READ_DB_SSLMODE',
    ],
  };
}

function databaseCredentialsFromLookup(request, lookup) {
  const aliases = databaseCredentialAliases(request);
  const username = lookup(request.username_key, aliases.username);
  const password = lookup(request.password_key, aliases.password);
  const database = lookup(request.database_key, aliases.database);
  const secretHost = lookup(request.host_key, aliases.host);
  const secretPort = lookup(request.port_key, aliases.port);
  const sslmode = lookup(undefined, aliases.sslmode);
  const port = request.port ?? (secretPort && /^\d+$/.test(secretPort.trim()) ? Number(secretPort.trim()) : DEFAULT_DATABASE_PORTS[request.engine]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Database port from the request or Secret is invalid');

  return {
    credentials: {
      username,
      password,
      database,
      host: request.host || secretHost || '127.0.0.1',
      port,
      sslmode,
    },
    hasSourceValues: [username, password, database, secretHost, secretPort].some((value) => value !== undefined),
  };
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/\\'/g, "'");
  return trimmed;
}

function parseMountedCredentialFile(content) {
  const text = String(content || '').replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // The CSI file used by the application is dotenv-style; continue below.
  }

  const values = {};
  for (const line of text.split(/\r?\n/)) {
    let candidate = line.trim();
    if (!candidate || candidate.startsWith('#')) continue;
    if (candidate.startsWith('export ')) candidate = candidate.slice('export '.length).trim();
    const separator = candidate.indexOf('=');
    if (separator <= 0) continue;
    const key = candidate.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    values[key] = parseEnvValue(candidate.slice(separator + 1));
  }
  return values;
}

function safeCsiFileName(value) {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().replace(/^['"]|['"]$/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate) ? candidate : undefined;
}

function extractCsiObjectFileNames(secretProviderClass, requestedName) {
  const rawObjects = secretProviderClass?.spec?.parameters?.objects;
  const candidates = [];
  const add = (value) => {
    const fileName = safeCsiFileName(value);
    if (fileName && !candidates.includes(fileName)) candidates.push(fileName);
  };

  if (typeof rawObjects === 'string') {
    for (const match of rawObjects.matchAll(/\bobjectAlias\s*:\s*["']?([^\s"']+)["']?/g)) add(match[1]);
    for (const match of rawObjects.matchAll(/\bobjectName\s*:\s*["']?([^\s"']+)["']?/g)) {
      const objectName = match[1].split('/').filter(Boolean).pop();
      add(objectName);
    }
  } else if (Array.isArray(rawObjects)) {
    for (const object of rawObjects) {
      if (!object || typeof object !== 'object') continue;
      add(object.objectAlias);
      const objectName = typeof object.objectName === 'string' ? object.objectName.split('/').filter(Boolean).pop() : undefined;
      add(objectName);
    }
  }

  // This is also the convention used by the repository's SecretProviderClass
  // manifests (pim-api-prod -> pim_api_prod). It covers providers that omit
  // objectAlias from the returned resource.
  add(requestedName.replace(/-/g, '_'));
  return candidates.slice(0, 8);
}

async function getKubernetesJson(context, namespace, args, timeoutMs, description) {
  const result = await runProcess(kubectlPath(), [
    '--context', context,
    '--namespace', namespace,
    ...args,
  ], Math.min(timeoutMs, 20_000), 512 * 1024);
  if (result.exitCode !== 0) {
    throw new Error(`${description}: ${redactText(result.stderr || 'kubectl request failed')}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

function findCsiMount(podDocument, request, secretProviderClassName) {
  const volumes = Array.isArray(podDocument?.spec?.volumes) ? podDocument.spec.volumes : [];
  const volume = volumes.find((candidate) => candidate?.csi?.driver === CSI_SECRETS_STORE_DRIVER
    && candidate?.csi?.volumeAttributes?.secretProviderClass === secretProviderClassName);
  if (!volume) throw new Error(`Pod ${request.pod} has no Secrets Store CSI volume for ${secretProviderClassName}`);
  if (volume.csi.readOnly === false) throw new Error(`CSI volume for ${secretProviderClassName} is not read-only`);

  const containers = Array.isArray(podDocument?.spec?.containers) ? podDocument.spec.containers : [];
  for (const container of containers) {
    if (request.container && container?.name !== request.container) continue;
    const mount = Array.isArray(container?.volumeMounts)
      ? container.volumeMounts.find((candidate) => candidate?.name === volume.name)
      : undefined;
    if (!mount || typeof mount.mountPath !== 'string' || !mount.mountPath.startsWith('/') || mount.mountPath.includes('\0')) continue;
    if (mount.readOnly === false) throw new Error(`CSI mount for ${secretProviderClassName} is not read-only`);
    return { container: container.name, mountPath: mount.mountPath.replace(/\/$/, '') || '/' };
  }
  throw new Error(`Pod ${request.pod} does not mount CSI volume ${volume.name} in the selected container`);
}

function databaseExecPrefix(context, request, withStdin, containerOverride) {
  const args = ['--context', context, '--namespace', request.namespace, 'exec'];
  if (withStdin) args.push('--stdin');
  args.push(request.pod);
  const container = containerOverride || request.container;
  if (container) args.push('--container', container);
  args.push('--');
  return args;
}

async function readCsiMountedFile(context, request, mount, fileName, timeoutMs) {
  const mountedPath = mount.mountPath === '/' ? `/${fileName}` : `${mount.mountPath}/${fileName}`;
  const result = await runProcess(kubectlPath(), [
    ...databaseExecPrefix(context, request, false, mount.container),
    'cat', '--', mountedPath,
  ], Math.min(timeoutMs, 20_000), MAX_CSI_SECRET_FILE_BYTES);
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new Error(`Unable to read CSI-mounted credential file ${fileName} from pod ${request.pod}`);
  }
  return result.stdout;
}

async function loadCsiDatabaseCredentials(context, request, timeoutMs) {
  const secretProviderClass = await getKubernetesJson(
    context,
    request.namespace,
    ['get', 'secretproviderclass', request.secret, '--output', 'json'],
    timeoutMs,
    `Unable to read SecretProviderClass ${request.secret}`,
  );
  const pod = await getKubernetesJson(
    context,
    request.namespace,
    ['get', 'pod', request.pod, '--output', 'json'],
    timeoutMs,
    `Unable to inspect pod ${request.pod} for CSI credentials`,
  );
  const mount = findCsiMount(pod, request, request.secret);
  const fileNames = extractCsiObjectFileNames(secretProviderClass, request.secret);
  if (fileNames.length === 0) throw new Error(`SecretProviderClass ${request.secret} has no safe mounted object alias`);

  for (const fileName of fileNames) {
    let content;
    try {
      content = await readCsiMountedFile(context, request, mount, fileName, timeoutMs);
    } catch {
      // A SecretProviderClass may contain multiple objects.  Do not include
      // provider output in the error because it can contain secret material.
      continue;
    }
    const values = parseMountedCredentialFile(content);
    const result = databaseCredentialsFromLookup(request, (key, aliases) => firstMapValue(values, key, aliases));
    if (result.hasSourceValues) return { ...result.credentials, container: mount.container };
  }

  throw new Error(`CSI SecretProviderClass ${request.secret} did not expose database credential keys in its mounted files`);
}

async function loadDatabaseCredentials(context, request, timeoutMs, { allowCsi = false } = {}) {
  let secretError;
  try {
    const document = await getKubernetesJson(
      context,
      request.namespace,
      ['get', 'secret', request.secret, '--output', 'json'],
      timeoutMs,
      `Unable to read Kubernetes Secret ${request.secret}`,
    );
    const result = databaseCredentialsFromLookup(request, (key, aliases) => firstSecretValue(document, key, aliases));
    if (result.hasSourceValues || !allowCsi) return result.credentials;
  } catch (error) {
    secretError = error;
  }

  if (!allowCsi) throw secretError || new Error(`Unable to read Kubernetes Secret ${request.secret}`);
  try {
    return await loadCsiDatabaseCredentials(context, request, timeoutMs);
  } catch (error) {
    const csiMessage = error instanceof Error ? error.message : String(error);
    const secretMessage = secretError instanceof Error ? secretError.message : 'Kubernetes Secret did not contain database credential keys';
    throw new Error(`Unable to load database credentials from ${request.secret}: ${secretMessage}; CSI fallback: ${csiMessage}`);
  }
}

function shellQuote(value) {
  const singleQuote = String.fromCharCode(39);
  const doubleQuote = String.fromCharCode(34);
  const escaped = String(value).split(singleQuote).join(`${singleQuote}${doubleQuote}${singleQuote}${doubleQuote}${singleQuote}`);
  return `${singleQuote}${escaped}${singleQuote}`;
}

function credentialShell(variable, fixedEnvironment = {}) {
  const fixedExports = Object.entries(fixedEnvironment)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(' ');
  return 'set -eu; IFS= read -r encoded; value="$(printf "%s" "$encoded" | base64 -d 2>/dev/null || printf "%s" "$encoded" | base64 --decode)"; export '
    + variable
    + '="$value"; unset encoded value; '
    + fixedExports
    + ' exec "$@"';
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
  // statements, SELECT ... INTO forms that can create/write data, and
  // EXPLAIN ANALYZE, which executes the underlying query.
  const statement = normalized.replace(/;\s*$/, '').trim();
  return DATABASE_READ_SQL.test(statement)
    && !statement.includes(';')
    && !/\binto\b/i.test(statement)
    && !/^explain\s+analyze\b/i.test(statement)
    && !/\bfor\s+(update|share)\b/i.test(statement);
}

function redactDatabaseOutput(value, credentials) {
  let output = redactText(value);
  for (const secret of [credentials.password, credentials.username, credentials.host]) {
    if (typeof secret === 'string' && secret.length >= 4) output = output.split(secret).join('[REDACTED:database-credential]');
  }
  return output;
}

function databaseClientInvocation(request, credentials) {
  let clientArgs;
  let credentialVariable;
  if (request.engine === 'postgres') {
    credentialVariable = 'PGPASSWORD';
    clientArgs = ['psql', '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '\\t', '--host', credentials.host, '--port', String(credentials.port)];
    if (credentials.username) clientArgs.push('--username', credentials.username);
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
  return { clientArgs, credentialVariable };
}

function localDatabaseClientPath(engine) {
  const envName = {
    postgres: 'DESKTOP_COMMANDER_DATABASE_PSQL_BIN',
    mysql: 'DESKTOP_COMMANDER_DATABASE_MYSQL_BIN',
    redis: 'DESKTOP_COMMANDER_DATABASE_REDIS_CLI_BIN',
  }[engine];
  return (envName && process.env[envName]) || ({ postgres: 'psql', mysql: 'mysql', redis: 'redis-cli' }[engine]);
}

function databaseClientEnvironment(credentials, credentialVariable) {
  const environment = {};
  if (credentials.password !== undefined) environment[credentialVariable] = credentials.password;
  if (credentials.sslmode && credentialVariable === 'PGPASSWORD') environment.PGSSLMODE = credentials.sslmode;
  return environment;
}

function databaseClientMissing(engine, result) {
  if (result.exitCode !== 127 || result.timedOut) return false;
  const client = { postgres: 'psql', mysql: 'mysql', redis: 'redis-cli' }[engine];
  const escaped = client.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\b${escaped}\\b.*(?:not found|No such file|cannot execute)|(?:not found|command not found).*\\b${escaped}\\b)`, 'i').test(result.stderr);
}

function databaseResult(result, context, credentials, commandLabel, timeoutMs) {
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
    command: commandLabel,
    exitCode: result.exitCode,
    signal: result.signal,
    output: redactDatabaseOutput(output, credentials),
    timedOut: result.timedOut,
  };
}

async function handleDatabaseRequest(request, context, timeoutMs) {
  if (request.mode === 'db_read' && !databaseReadQueryAllowed(request.engine, request.query)) {
    throw new Error('This database operation is not classified as read-only; use the confirmation-protected database_mutate tool');
  }
  const credentials = await loadDatabaseCredentials(context, request, timeoutMs, { allowCsi: true });
  const { clientArgs, credentialVariable } = databaseClientInvocation(request, credentials);
  const execArgs = databaseExecPrefix(context, request, credentials.password !== undefined, credentials.container);

  // Send the credential over kubectl exec's stdin as base64 instead of putting
  // it in kubectl's argv or the host process environment. The query itself is
  // passed as argv to the database client; no shell interpolation is used.
  const fixedEnvironment = credentials.sslmode && request.engine === 'postgres'
    ? { PGSSLMODE: credentials.sslmode }
    : {};
  const command = credentials.password !== undefined
    ? [...execArgs, 'sh', '-c', credentialShell(credentialVariable, fixedEnvironment), 'sh', ...clientArgs]
    : [...execArgs, ...clientArgs];
  const credentialInput = credentials.password !== undefined
    ? `${Buffer.from(credentials.password, 'utf8').toString('base64')}\n`
    : undefined;
  const result = await runProcess(kubectlPath(), command, timeoutMs, MAX_OUTPUT_BYTES, credentialInput);
  if (credentials.container
    && credentials.host !== '127.0.0.1'
    && databaseClientMissing(request.engine, result)) {
    // Some CSI-backed application images intentionally omit database clients.
    // Keep credentials on the host and use the host-native client against the
    // same endpoint. Mutations remain confirmation-protected by validateRequest.
    const localResult = await runProcess(
      localDatabaseClientPath(request.engine),
      clientArgs.slice(1),
      timeoutMs,
      MAX_OUTPUT_BYTES,
      undefined,
      databaseClientEnvironment(credentials, credentialVariable),
    );
    const operationLabel = request.mode === 'db_read' ? 'read-only operation' : 'confirmed mutation';
    return databaseResult(
      localResult,
      context,
      credentials,
      `database ${request.engine} ${operationLabel} via host client (pod ${request.pod})`,
      timeoutMs,
    );
  }

  return databaseResult(result, context, credentials, `database ${request.engine} operation in pod ${request.pod}`, timeoutMs);
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
