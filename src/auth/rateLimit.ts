import rateLimit from "express-rate-limit";

/**
 * Per-IP throttles for the /mcp endpoint, mirroring the fixed-window policies already used for
 * the same signup flow in the main NomadStays web app (Program.cs's "agent-signup" RateLimiter
 * policy: 2 POSTs / 5 min / IP) — this server had no rate limiting at all before, which matters
 * because most of its tools (including signupNomadStaysAccount) are reachable with zero
 * credentials by design (see auth/protectedTools.ts's "lazy authentication" doc comment).
 *
 * trust proxy is already set (see index.ts's app.set('trust proxy', true)), so req.ip below
 * resolves to the real client IP from X-Forwarded-For behind Coolify's reverse proxy, not the
 * proxy's own address.
 */

// General /mcp throttle — covers tools/list, initialize, and every public (unauthenticated)
// tool call. Generous enough that a normal MCP client working through a multi-step tool-call
// conversation never trips it, but bounds naive scripted abuse of the wide-open public surface.
export const mcpEndpointLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { jsonrpc: "2.0", error: { code: -32029, message: "Too many requests. Please slow down and try again shortly." }, id: null },
});

// signupNomadStaysAccount-specific throttle — same shape as Program.cs's "agent-signup" policy.
// Kept tighter than the general limiter above since account creation has no other pre-confirmation
// throttle at this layer (no Turnstile/honeypot — this is a non-browser MCP caller), matching the
// reasoning in Program.cs's own comment for why agent-signup is tighter than the human "signup" policy.
const SIGNUP_WINDOW_MS = 5 * 60_000;
const SIGNUP_LIMIT = 2;
const signupHits = new Map<string, { count: number; resetAt: number }>();

/** True if this caller IP is currently over the signup rate limit — checked inside the /mcp handler, not as Express middleware, since it must fire only for one specific tool name within the single shared /mcp route. */
export function isSignupRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = signupHits.get(clientIp);
  if (!entry || now >= entry.resetAt) {
    signupHits.set(clientIp, { count: 1, resetAt: now + SIGNUP_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > SIGNUP_LIMIT;
}

/** True if this JSON-RPC request body is a tools/call targeting signupNomadStaysAccount. Same batched-body handling as protectedTools.ts's requestCallsProtectedTool. */
export function requestCallsSignup(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((msg) => {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as { method?: unknown; params?: { name?: unknown } };
    return m.method === "tools/call" && m.params?.name === "signupNomadStaysAccount";
  });
}
