/**
 * Carries the per-request MCP agent bearer token (from the caller's own
 * Authorization header on /mcp) through to mcpAgentClient without threading
 * it through every tool-handler call site. Set once per HTTP request in the
 * Express handler; read by mcpAgentClient.getToken().
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string | undefined>();

export function runWithRequestAgentToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  return storage.run(token, fn);
}

export function getRequestAgentToken(): string | undefined {
  return storage.getStore();
}
