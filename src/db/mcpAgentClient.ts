/**
 * Thin HTTP client for the write-capable MCP agent API exposed by the
 * NomadStays web app (Controllers/McpAgentApiController.cs), authenticated
 * with a bearer token issued at Pages/siteadmin/mcp-tokens-admin.cshtml.
 *
 * The token is read from NOMADSTAYS_MCP_AGENT_TOKEN, the same env-var-per-
 * deployment convention already used for NOMADSTAYS_DB_CONNECTION — one
 * running instance of this server acts on behalf of one host account.
 */

const DEFAULT_BASE_URL = "https://nomadstays.com/api/mcp-agent";

function getBaseUrl(): string {
  return (process.env.NOMADSTAYS_MCP_AGENT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getToken(): string {
  const token = process.env.NOMADSTAYS_MCP_AGENT_TOKEN;
  if (!token) {
    throw new Error(
      "Environment variable NOMADSTAYS_MCP_AGENT_TOKEN must be set to call write tools " +
      "(issue a token at nomadstays.com/siteadmin/mcp-tokens-admin)"
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
  getAdditionalInformationOptions: (filterName: string) =>
    call("GET", `/reference/additional-information/${encodeURIComponent(filterName)}`),
};
