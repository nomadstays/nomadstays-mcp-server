/**
 * Validates a caller-supplied bearer token against the ASP.NET OAuth server's
 * POST /oauth/introspect (RFC 7662-shaped) before allowing a protected tool call through.
 *
 * Only applies to OAuth-issued tokens (prefix "mcpoauth_at_"). Legacy static bearer tokens
 * (prefix "mcp_...", issued at nomadstays.com/siteadmin/mcp-tokens-admin) are NOT introspected
 * here — they're opaque to this server either way, and are fully validated downstream when
 * mcpAgentClient actually calls McpAgentApiController, which is the same as before this change.
 * This module's only job is deciding whether to let an OAuth-flavored token past the lazy-auth
 * gate, specifically checking its RFC 8707 audience (aud) matches this resource server's own
 * canonical URI — a token minted for some other resource must not work here.
 */

// www. explicitly: nomadstays.com 302-redirects to www.nomadstays.com, and a 302 on a POST can
// get converted to a GET across the hop by some clients/specs — pointing directly at www.
// avoids the redirect entirely rather than relying on it behaving correctly. See the matching
// fix + comment in ../db/mcpAgentClient.ts, where the same apex-vs-www redirect silently
// stripped the Authorization header on every single request.
const OAUTH_BASE_URL = (process.env.NOMADSTAYS_OAUTH_BASE_URL ?? "https://www.nomadstays.com").replace(/\/+$/, "");

// Canonical resource URI this server identifies itself as, per RFC 8707. Must match exactly
// what /oauth/authorize and /oauth/token were told via the `resource` parameter.
export const RESOURCE_URI = (process.env.MCP_RESOURCE_URI ?? "https://mcp.nomadstays.com/mcp");

export function looksLikeOAuthToken(token: string): boolean {
  return token.startsWith("mcpoauth_at_");
}

export function looksLikeLegacyToken(token: string): boolean {
  return token.startsWith("mcp_");
}

export async function introspectOAuthToken(token: string): Promise<{ active: boolean; sub?: string; aud?: string }> {
  const response = await fetch(`${OAUTH_BASE_URL}/oauth/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });

  if (!response.ok) return { active: false };
  const data = await response.json() as { active: boolean; sub?: string; aud?: string };
  return data;
}

/**
 * Returns true only if the token is present, is a recognized shape, and — for OAuth tokens —
 * is active and correctly audience-bound to this resource server. Legacy mcp_... tokens pass
 * this gate on shape alone (they carry no audience concept); actual authorization still happens
 * downstream at McpAgentApiController exactly as before. Anything that matches neither shape
 * (garbage, a copy-paste error, an unrelated credential) is rejected here — it must not reach
 * mcpAgentClient at all, since a plausible-but-wrong string there would just surface as an
 * opaque 401 from nomadstays.com instead of the correct MCP-level challenge.
 */
export async function isTokenAcceptable(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  if (looksLikeLegacyToken(token)) return true; // validated downstream at McpAgentApiController, as before
  if (!looksLikeOAuthToken(token)) return false; // neither known shape — reject outright

  const { active, aud } = await introspectOAuthToken(token);
  if (!active) return false;
  // No audience on the token (pre-resource-binding, or a client that never sent `resource`)
  // is treated as "not scoped to us" and rejected — this server started requiring resource
  // binding going forward, so an unscoped OAuth token should re-authenticate through the
  // proper flow rather than be trusted implicitly.
  return aud === RESOURCE_URI;
}
