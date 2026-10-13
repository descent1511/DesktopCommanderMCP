import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerResult } from '../types.js';
import {
    GitMutateArgsSchema,
    GitReadArgsSchema,
} from './schemas.js';

const BRIDGE_DIR = process.env.DESKTOP_COMMANDER_GIT_BRIDGE_DIR || '/run/desktop-commander-git';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type GitBridgeRequest = {
    repo: string;
    action: string;
    args: string[];
    timeout_ms: number;
    mode: 'read' | 'mutate';
    confirm?: boolean;
};

type GitBridgeResponse = {
    ok?: boolean;
    repo?: string;
    action?: string;
    command?: string;
    exitCode?: number | null;
    signal?: string | null;
    output?: string;
    error?: string;
    timedOut?: boolean;
};

function errorResult(message: string): ServerResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
    };
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callHostBridge(request: GitBridgeRequest): Promise<GitBridgeResponse> {
    const requestName = `request-${process.pid}-${Date.now()}-${randomUUID()}`;
    const requestPath = path.join(BRIDGE_DIR, `${requestName}.json`);
    const tempRequestPath = `${requestPath}.tmp`;
    const responsePath = path.join(BRIDGE_DIR, `${requestName}.response.json`);
    const deadline = Date.now() + Math.min(request.timeout_ms + 10_000, 135_000);

    try {
        await fs.writeFile(tempRequestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
        await fs.rename(tempRequestPath, requestPath);

        while (Date.now() < deadline) {
            try {
                const responseText = await fs.readFile(responsePath, 'utf8');
                if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE_BYTES) {
                    return { ok: false, error: 'Local Git bridge response exceeded the safety limit' };
                }
                return JSON.parse(responseText) as GitBridgeResponse;
            } catch (error) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                if (code !== 'ENOENT') {
                    return { ok: false, error: `Local Git bridge returned invalid response: ${String(error)}` };
                }
                await sleep(25);
            }
        }
        return { ok: false, error: 'Local Git bridge timed out while waiting for the host connector' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            error: `Local Git bridge is unavailable at ${BRIDGE_DIR}: ${message}`,
        };
    } finally {
        await fs.unlink(tempRequestPath).catch(() => {});
        await fs.unlink(requestPath).catch(() => {});
        await fs.unlink(responsePath).catch(() => {});
    }
}

function bridgeResponseToResult(response: GitBridgeResponse): ServerResult {
    if (response.error) return errorResult(response.error);
    const status = response.ok ? 'completed' : 'failed';
    const details = [
        `Git ${response.action ?? 'operation'} ${status}${response.repo ? ` in ${response.repo}` : ''}.`,
        response.command ? `Command: ${response.command}` : '',
        response.output ?? '',
        response.exitCode !== undefined && response.exitCode !== null ? `Exit code: ${response.exitCode}` : '',
        response.signal ? `Signal: ${response.signal}` : '',
    ].filter(Boolean).join('\n');
    return {
        content: [{ type: 'text', text: details }],
        isError: !response.ok,
    };
}

export async function handleGitRead(args: unknown): Promise<ServerResult> {
    const parsed = GitReadArgsSchema.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid Git read arguments: ${parsed.error.message}`);
    if (parsed.data.action === 'fetch' && parsed.data.confirm !== true) {
        return errorResult('Confirmation required: git fetch updates local remote-tracking refs; retry with confirm=true after the user confirms. No command was executed.');
    }

    const response = await callHostBridge({
        ...parsed.data,
        mode: 'read',
    });
    return bridgeResponseToResult(response);
}

export async function handleGitMutate(args: unknown): Promise<ServerResult> {
    const parsed = GitMutateArgsSchema.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid Git change arguments: ${parsed.error.message}`);
    if (parsed.data.confirm !== true) {
        return errorResult('Confirmation required: ask the user to confirm the exact Git repository, action, and arguments, then retry with confirm=true. No command was executed.');
    }

    const response = await callHostBridge({
        ...parsed.data,
        mode: 'mutate',
    });
    return bridgeResponseToResult(response);
}
