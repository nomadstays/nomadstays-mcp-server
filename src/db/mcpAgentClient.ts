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

// The web app exposes a few sibling controllers under their own route prefixes rather than
// api/mcp-agent (Controllers/McpProductPaymentApiController.cs, McpStayApplicationApiController.cs)
// — same host, same auth scheme/token, just a different path segment. `call()` accepts an
// optional `base` override so this one client file/module (with its one token-resolution and
// error-handling implementation) can reach them without a second near-duplicate client.
const API_BASES = {
  agent: "mcp-agent",
  productPayment: "mcp-product-payment",
  stayApplication: "mcp-stay-application",
  experienceApplication: "mcp-experience-application",
  coworkingApplication: "mcp-coworking-application",
} as const;
type ApiBase = keyof typeof API_BASES;

function getBaseUrl(base: ApiBase = "agent"): string {
  const root = (process.env.NOMADSTAYS_MCP_AGENT_BASE_URL ?? DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/api\/mcp-agent$/, "/api");
  return base === "agent" ? `${root}/mcp-agent` : `${root}/${API_BASES[base]}`;
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

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  base: ApiBase = "agent",
): Promise<any> {
  const response = await fetch(`${getBaseUrl(base)}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return handleResponse(response);
}

// Site root (not /api/mcp-agent) for the handful of endpoints that exist precisely because no
// token can exist yet — account signup — so they can't go through call()'s getToken() above,
// which throws when there's nothing to authenticate with.
function getSiteRoot(): string {
  return (process.env.NOMADSTAYS_MCP_AGENT_BASE_URL ?? DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/api\/mcp-agent$/, "");
}

async function callAnonymous(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${getSiteRoot()}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return handleResponse(response);
}

async function handleResponse(response: Response): Promise<any> {
  if (response.status === 204) return null;

  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Some endpoints (e.g. the rate limiter's rejection handler) reply with a plain-text
      // body instead of JSON — surface it as-is rather than throwing a confusing parse error.
      if (!response.ok) throw new Error(text || `Request failed with status ${response.status}`);
      data = text;
    }
  }

  if (!response.ok) {
    const message = data?.error ?? data?.errors ?? `Request failed with status ${response.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data;
}

export const mcpAgentClient = {
  // ── Account signup (Controllers/AgentSignupApiController.cs) ────────────
  // No token exists yet at this point — that's the entire reason this tool exists — so it
  // calls the site directly (callAnonymous) instead of going through the bearer-token call()
  // used by every other method here. Creates an inactive account; the human still has to
  // click the emailed confirmation link before it's usable, and no session/token is returned.
  signUp: (body: {
    firstName: string;
    lastName: string;
    email: string;
    telephone: string;
    password: string;
    acceptGdpr: boolean;
  }) => callAnonymous("POST", `/api/agent-signup`, body),

  getMyStays: () => call("GET", `/stays`),
  getStayDetail: (stayId: string | number) => call("GET", `/stays/${stayId}`),
  patchStayDetail: (stayId: string | number, body: unknown) => call("PATCH", `/stays/${stayId}`, body),
  getOnboardingStatus: (stayId: string | number) => call("GET", `/stays/${stayId}/onboarding-status`),

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

  // ── Coworking Application (Controllers/McpCoworkingApplicationApiController.cs) ──
  // Simpler than the Stay/Experience tools above — mirrors
  // Pages/applications/apply-to-list-your-coworking-{1,3}.cshtml.cs. No Application Fee, no
  // purchaseProduct() call needed: nextAction goes straight to "submit" once the required
  // fields (coworkingName, applicantName, applicantEmail, city, country) are present.
  listCoworkingApplications: () => call("GET", `/`, undefined, "coworkingApplication"),
  getCoworkingApplication: (applicationId: string | number) =>
    call("GET", `/${applicationId}`, undefined, "coworkingApplication"),
  createCoworkingApplication: (body: unknown) => call("POST", `/`, body, "coworkingApplication"),
  saveCoworkingApplication: (applicationId: string | number, body: unknown) =>
    call("PATCH", `/${applicationId}`, body, "coworkingApplication"),
  submitCoworkingApplication: (applicationId: string | number) =>
    call("POST", `/${applicationId}/submit`, undefined, "coworkingApplication"),

  // ── Product payment (Controllers/McpProductPaymentApiController.cs) ──────
  // Lets the caller buy a tbProducts row (product 8 "Stay Application" or product 9
  // "Experience Application", both €39) on their own behalf. Coworking has no application-fee
  // product — see the Coworking Application tools above. The agent never touches card
  // data: purchaseProduct returns a checkoutUrl hosted on nomadstays.com that the member
  // must open and pay through themselves; getPurchaseStatus only ever reports "paid" after
  // a fresh server-side re-check against Airwallex, never from a client-supplied claim.
  getProductInfo: (productId: string | number) =>
    call("GET", `/products/${productId}`, undefined, "productPayment"),
  purchaseProduct: (productId: string | number, applicationId?: string | number) =>
    call(
      "POST",
      `/products/${productId}/checkout${applicationId != null ? `?applicationId=${applicationId}` : ""}`,
      undefined,
      "productPayment",
    ),
  getPurchaseStatus: (saleId: string) => call("GET", `/sales/${saleId}/status`, undefined, "productPayment"),

  // ── Stay Application (Controllers/McpStayApplicationApiController.cs) ────
  // Mirrors Pages/applications/apply-to-list-your-stay-{1..4}.cshtml.cs as one consolidated
  // create/save/submit surface — see docs/AI_AGENT_STAY_APPLICATION_PLAN.md in nomadstayscom26
  // for the full design. Billing for the Application Fee goes through the product-payment
  // tools above (product 8), not a separate payment path here.
  listStayApplications: () => call("GET", `/`, undefined, "stayApplication"),
  getStayApplication: (applicationId: string | number) =>
    call("GET", `/${applicationId}`, undefined, "stayApplication"),
  createStayApplication: (body: unknown) => call("POST", `/`, body, "stayApplication"),
  saveStayApplication: (applicationId: string | number, body: unknown) =>
    call("PATCH", `/${applicationId}`, body, "stayApplication"),
  submitStayApplication: (applicationId: string | number) =>
    call("POST", `/${applicationId}/submit`, undefined, "stayApplication"),

  // ── Experience Application (Controllers/McpExperienceApplicationApiController.cs) ─
  // Same consolidated create/save/submit pattern as the Stay Application tools above —
  // mirrors Pages/applications/apply-to-list-your-experience-{1..4}.cshtml.cs. Billing goes
  // through purchaseProduct(9, applicationId), NOT product 8 — Experience has its own
  // Application Fee product so Pumble/email notifications carry the correct product name.
  listExperienceApplications: () => call("GET", `/`, undefined, "experienceApplication"),
  getExperienceApplication: (applicationId: string | number) =>
    call("GET", `/${applicationId}`, undefined, "experienceApplication"),
  createExperienceApplication: (body: unknown) => call("POST", `/`, body, "experienceApplication"),
  saveExperienceApplication: (applicationId: string | number, body: unknown) =>
    call("PATCH", `/${applicationId}`, body, "experienceApplication"),
  submitExperienceApplication: (applicationId: string | number) =>
    call("POST", `/${applicationId}/submit`, undefined, "experienceApplication"),
};
