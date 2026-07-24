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

// www. explicitly, not the apex domain: nomadstays.com 302-redirects to www.nomadstays.com,
// and both fetch and curl strip the Authorization header on cross-host redirects per the
// fetch spec's redirect-fetch algorithm — every call through the apex silently lost its
// bearer token on the hop and got a 401 back from McpAgentApiController with no token at all,
// not even an invalid one. Found by tracing a live Claude.ai request that had a genuinely
// valid, correctly resource-bound OAuth token but still got rejected.
const DEFAULT_BASE_URL = "https://www.nomadstays.com/api/mcp-agent";

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

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<any> {
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
  deletePackage: (stayId: string | number, packageId: string | number) =>
    call("DELETE", `/stays/${stayId}/packages/${packageId}`),
  getCurrencies: () => call("GET", `/reference/currencies`),

  getStayOrganisational: (stayId: string | number) => call("GET", `/stays/${stayId}/organisational`),
  patchStayOrganisational: (stayId: string | number, body: unknown) =>
    call("PATCH", `/stays/${stayId}/organisational`, body),

  getBusinessProfile: () => call("GET", `/profile/business`),
  patchBusinessProfile: (body: unknown) => call("PATCH", `/profile/business`, body),

  uploadPhoto: (stayId: string | number, body: unknown) => call("POST", `/stays/${stayId}/photos`, body),

  getStayContacts: (stayId: string | number) => call("GET", `/stays/${stayId}/contacts`),
  patchStayContacts: (stayId: string | number, body: unknown) => call("PATCH", `/stays/${stayId}/contacts`, body),

  getStayFacilities: (stayId: string | number, group: string) =>
    call("GET", `/stays/${stayId}/facilities/${encodeURIComponent(group)}`),
  patchStayFacilities: (stayId: string | number, group: string, body: unknown) =>
    call("PATCH", `/stays/${stayId}/facilities/${encodeURIComponent(group)}`, body),

  getFacilityGroups: () => call("GET", `/reference/facility-groups`),
  getStayTypes: () => call("GET", `/reference/stay-types`),
  getCountries: () => call("GET", `/reference/countries`),
  getCancellationPolicies: () => call("GET", `/reference/cancellation-policies`),
  getBusinessModels: () => call("GET", `/reference/business-models`),
  getAdditionalInformationOptions: (filterName: string) =>
    call("GET", `/reference/additional-information/${encodeURIComponent(filterName)}`),

  getStayPhotos: (stayId: string | number) => call("GET", `/stays/${stayId}/photos`),
  deleteStayPhoto: (stayId: string | number, area: string, fileName: string) =>
    call("DELETE", `/stays/${stayId}/photos/${encodeURIComponent(area)}/${encodeURIComponent(fileName)}`),
  reorderStayPhotos: (stayId: string | number, area: string, body: unknown) =>
    call("PATCH", `/stays/${stayId}/photos/${encodeURIComponent(area)}/order`, body),

  deleteRoom: (stayId: string | number, roomId: string | number) =>
    call("DELETE", `/stays/${stayId}/rooms/${roomId}`),
  getRoomTypesForStay: (stayId: string | number) => call("GET", `/stays/${stayId}/reference/room-types`),
  getRoomFacilities: () => call("GET", `/reference/room-facilities`),
  deleteRoomPhoto: (stayId: string | number, roomId: string | number, roomArea: string, fileName: string) =>
    call("DELETE", `/stays/${stayId}/rooms/${roomId}/photos/${encodeURIComponent(roomArea)}/${encodeURIComponent(fileName)}`),
  reorderRoomPhotos: (stayId: string | number, roomId: string | number, roomArea: string, body: unknown) =>
    call("PATCH", `/stays/${stayId}/rooms/${roomId}/photos/${encodeURIComponent(roomArea)}/order`, body),
};
