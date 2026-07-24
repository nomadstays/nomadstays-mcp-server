/**
 * Owner-scoped tools that require a caller-supplied MCP agent token — every tool whose
 * handler calls mcpAgentClient (see src/db/mcpAgentClient.ts). Derived directly from the
 * CallToolRequestSchema dispatch in index.ts, not from tool descriptions (some read-only
 * reference-lookup tools mention "Requires NOMADSTAYS_MCP_AGENT_TOKEN" in their description
 * text for documentation purposes but are actually just owner-scoped reads, same as the
 * write tools below — the two categories behave identically for auth purposes).
 *
 * Used for MCP "lazy authentication" (see docs/architecture note in index.ts's /mcp handler):
 * public tools work with zero credentials; calling one of these without a valid token gets a
 * transport-level 401 + WWW-Authenticate challenge instead of a silent tool-result error, so
 * MCP clients (Claude.ai, ChatGPT) that support the OAuth flow auto-prompt the user to connect.
 */
export const PROTECTED_TOOLS = new Set([
  "createStayPackage",
  "createStayRoom",
  "deleteRoomPhoto",
  "deleteStayPackage",
  "deleteStayPhoto",
  "deleteStayRoom",
  "getAdditionalInformationOptions",
  "getBusinessModelOptions",
  "getCancellationPolicyOptions",
  "getCountryOptions",
  "getCurrencyOptions",
  "getFacilityGroups",
  "getMyBusinessProfile",
  "getMyStayContacts",
  "getMyStayDetail",
  "getMyStayFacilities",
  "getMyStayOrganisationalData",
  "getMyStayPackages",
  "getMyStayPhotos",
  "getMyStayRooms",
  "getMyStays",
  "getRoomFacilityOptions",
  "getRoomTypeOptions",
  "getStayTypeOptions",
  "reorderRoomPhotos",
  "reorderStayPhotos",
  "updateHostBusinessProfile",
  "updateStayContacts",
  "updateStayDetail",
  "updateStayFacilities",
  "updateStayOrganisationalData",
  "updateStayPackage",
  "updateStayRoom",
  "uploadStayPhoto",
]);

/** True if this JSON-RPC request body is a tools/call targeting a protected tool. Handles both single and batched (array) JSON-RPC bodies, per the MCP spec. */
export function requestCallsProtectedTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((msg) => {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as { method?: unknown; params?: { name?: unknown } };
    return m.method === "tools/call" && typeof m.params?.name === "string" && PROTECTED_TOOLS.has(m.params.name);
  });
}
