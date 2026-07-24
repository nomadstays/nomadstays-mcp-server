/**
 * Thin HTTP client for the write-capable MCP agent API exposed by the
 * NomadStays web app (Controllers/McpAgentApiController.cs), authenticated
 * with a bearer token issued at Pages/siteadmin/mcp-tokens-admin.cshtml.
 *
 * The token comes from the caller's own `Authorization: Bearer mcp_...` header
 * on the incoming /mcp request (see requestTokenContext.ts), NOT from a
 * server-wide env var — every caller must present their own token, scoped to
 * their own host account, or write tools are refused. This was previously a
 * single shared NOMADSTAYS_MCP_AGENT_TOKEN env var used on behalf of every
 * caller regardless of who they were, which let anonymous callers of this
 * MCP server trigger writes against whichever host account that token
 * belonged to. NOMADSTAYS_MCP_AGENT_TOKEN is still supported as a fallback
 * ONLY for local/stdio mode (no per-request caller to take a token from).
 */

import { getRequestAgentToken } from "../tracking/requestTokenContext.js";

const DEFAULT_BASE_URL = "https://nomadstays.com/api/mcp-agent";

function getBaseUrl(): string {
  return (process.env.NOMADSTAYS_MCP_AGENT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getToken(): string {
  const token = getRequestAgentToken() ?? process.env.NOMADSTAYS_MCP_AGENT_TOKEN;
  if (!token) {
    throw new Error(
      "No MCP agent token supplied. Send 'Authorization: Bearer <token>' with your MCP request " +
      "(issue a token at nomadstays.com/siteadmin/mcp-tokens-admin)."
    );
  }
  return token;
}

async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.error ?? `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

export const mcpAgentClient = {
  getMyStays: () => call("GET", `/stays`),
  getStayDetail: (stayId: string | number) => call("GET", `/stays/${stayId}`),
  patchStayDetail: (stayId: string | number, body: unknown) => call("PATCH", `/stays/${stayId}`, body),

  getRooms: (stayId: string | number) => call("GET", `/stays/${stayId}/rooms`),
  createRoom: (stayId: string | number, body: unknown) => call("POST", `/stays/${stayId}/rooms`, body),
  patchRoom: (stayId: string | number, roomId: string | number, body: unknown) =>
    call("PATCH", `/stays/${stayId}/rooms/${roomId}`, body),

  getPackages: (stayId: string | number) => call("GET", `/stays/${stayId}/packages`),
  createPackage: (stayId: string | number, body: unknown) => call("POST", `/stays/${stayId}/packages`, body),
  patchPackage: (stayId: string | number, packageId: string | number, body: unknown) =>
    call("PATCH", `/stays/${stayId}/packages/${packageId}`, body),

  getStayOrganisational: (stayId: string | number) => call("GET", `/stays/${stayId}/organisational`),
  patchStayOrganisational: (stayId: string | number, body: unknown) =>
    call("PATCH", `/stays/${stayId}/organisational`, body),

  getBusinessProfile: () => call("GET", `/profile/business`),
  patchBusinessProfile: (body: unknown) => call("PATCH", `/profile/business`, body),

  uploadPhoto: (stayId: string | number, body: unknown) => call("POST", `/stays/${stayId}/photos`, body),
};
