import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServerResult } from '../types.js';
import {
    KubernetesMutateArgsSchema,
    KubernetesReadArgsSchema,
} from './schemas.js';

const BRIDGE_DIR = process.env.DESKTOP_COMMANDER_KUBERNETES_BRIDGE_DIR || '/run/desktop-commander-kubernetes';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

export type HostBridgeRequest = {
    context: 'uat' | 'prod';
    timeout_ms: number;
    mode: 'read' | 'mutate' | 'db_read' | 'db_mutate';
    confirm?: boolean;
    [key: string]: unknown;
};

export type HostBridgeResponse = {
    ok?: boolean;
    context?: string;
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

function commandName(args: string[]): string {
    return args[0]?.toLowerCase() ?? '';
}

function validateReadCommand(args: string[]): string | undefined {
    const command = commandName(args);
    if (!READ_COMMANDS.has(command)) {
        return `kubectl ${command || '(missing command)'} is not read-only; use kubernetes_mutate and wait for confirmation`;
    }
    return undefined;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function callHostBridge(request: HostBridgeRequest): Promise<HostBridgeResponse> {
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
                    return { ok: false, error: 'Local bridge response exceeded the safety limit' };
                }
                return JSON.parse(responseText) as HostBridgeResponse;
            } catch (error) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                if (code !== 'ENOENT') {
                    return { ok: false, error: `Local bridge returned invalid response: ${String(error)}` };
                }
                await sleep(25);
            }
        }
        return { ok: false, error: 'Local bridge timed out while waiting for the host connector' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            error: `Local bridge is unavailable at ${BRIDGE_DIR}: ${message}`,
        };
    } finally {
        await fs.unlink(tempRequestPath).catch(() => {});
        await fs.unlink(requestPath).catch(() => {});
        await fs.unlink(responsePath).catch(() => {});
    }
}

export function bridgeResponseToResult(response: HostBridgeResponse, label: string): ServerResult {
    if (response.error) return errorResult(response.error);
    const status = response.ok ? 'completed' : 'failed';
    const details = [
        `${label} ${status} on ${response.context ?? 'unknown context'}.`,
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

export async function handleKubernetesRead(args: unknown): Promise<ServerResult> {
    const parsed = KubernetesReadArgsSchema.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid Kubernetes read arguments: ${parsed.error.message}`);
    const commandError = validateReadCommand(parsed.data.args);
    if (commandError) return errorResult(commandError);

    const response = await callHostBridge({
        ...parsed.data,
        mode: 'read',
    });
    return bridgeResponseToResult(response, 'Kubernetes');
}

export async function handleKubernetesMutate(args: unknown): Promise<ServerResult> {
    const parsed = KubernetesMutateArgsSchema.safeParse(args);
    if (!parsed.success) return errorResult(`Invalid Kubernetes change arguments: ${parsed.error.message}`);
    if (parsed.data.confirm !== true) {
        return errorResult('Confirmation required. Ask the user to confirm the exact Kubernetes command, then retry with confirm=true. No command was executed.');
    }

    const response = await callHostBridge({
        ...parsed.data,
        mode: 'mutate',
    });
    return bridgeResponseToResult(response, 'Kubernetes');
}
