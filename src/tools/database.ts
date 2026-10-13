import type { ServerResult } from '../types.js';
import {
    DatabaseMutateArgsSchema,
    DatabaseReadArgsSchema,
} from './schemas.js';
import {
    bridgeResponseToResult,
    callHostBridge,
} from './kubernetes.js';

function errorResult(message: string): ServerResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
    };
}

function readOnlyError(engine: string): string {
    if (engine === 'redis') {
        return 'This Redis command is not classified as read-only; use database_mutate and wait for confirmation';
    }
    return 'This SQL statement is not classified as read-only; use database_mutate and wait for confirmation';
}

function validateReadQuery(engine: string, query: string): string | undefined {
    const normalized = query
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\r\n]*/g, ' ')
        .trim();

    if (engine === 'redis') {
        const command = normalized.split(/\s+/, 1)[0]?.toUpperCase() ?? '';
        const readCommands = new Set([
            'CLIENT', 'COMMAND', 'DBSIZE', 'ECHO', 'EXISTS', 'GET', 'GETDEL', 'GETEX',
            'HGET', 'HGETALL', 'HEXISTS', 'HLEN', 'HMGET', 'HSCAN', 'INFO', 'LLEN',
            'LINDEX', 'LRANGE', 'MEMORY', 'MGET', 'OBJECT', 'PING', 'PTTL', 'RANDOMKEY',
            'SCAN', 'SCARD', 'SDIFF', 'SISMEMBER', 'SMEMBERS', 'SSCAN', 'STRLEN', 'TIME',
            'TTL', 'TYPE', 'XLEN', 'XRANGE', 'XREAD', 'ZCARD', 'ZRANGE', 'ZRANK', 'ZSCAN',
        ]);
        return readCommands.has(command) ? undefined : readOnlyError(engine);
    }

    // CTEs are deliberately routed through the confirmation-protected tool:
    // WITH ... UPDATE/DELETE/INSERT can mutate even when the first token is WITH.
    // SELECT INTO and EXPLAIN ANALYZE also execute/write beyond a safe read.
    return /^(select|show|describe|desc|explain)\b/i.test(normalized)
        && !/\binto\b/i.test(normalized)
        && !/^explain\s+analyze\b/i.test(normalized)
        ? undefined
        : readOnlyError(engine);
}

export async function handleDatabaseRead(args: unknown): Promise<ServerResult> {
    const parsed = DatabaseReadArgsSchema.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid database read arguments: ${parsed.error.message}`);
    const queryError = validateReadQuery(parsed.data.engine, parsed.data.query);
    if (queryError) return errorResult(queryError);

    const response = await callHostBridge({
        ...parsed.data,
        mode: 'db_read',
    });
    return bridgeResponseToResult(response, 'Database query');
}

export async function handleDatabaseMutate(args: unknown): Promise<ServerResult> {
    const parsed = DatabaseMutateArgsSchema.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid database change arguments: ${parsed.error.message}`);
    if (parsed.data.confirm !== true) {
        return errorResult('Confirmation required. Ask the user to confirm the exact database operation, then retry with confirm=true. No query was executed.');
    }

    const response = await callHostBridge({
        ...parsed.data,
        mode: 'db_mutate',
    });
    return bridgeResponseToResult(response, 'Database query');
}
