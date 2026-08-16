import { Request, Response, NextFunction } from 'express';
import { MCPRequestLogger } from './requestLogger.js';

// Tool argument keys that must never reach tbMCPRequestTracking in plaintext — currently just
// signupNomadStaysAccount's password, but matched case-insensitively so a differently-cased or
// future credential-shaped field (token, secret, apiKey, ...) is caught too rather than only
// the one field known today.
const SENSITIVE_KEY_PATTERN = /password|secret|token|apikey|api_key/i;

// Large string values (base64 photo payloads chief among them) bloat tbMCPRequestTracking with
// bytes nobody queries by, and there's no reason for that raw image data to sit in a log table.
// Redact rather than drop the key entirely so the log still shows a tool call happened with a
// photo attached, just not the photo itself.
const MAX_LOGGED_STRING_LENGTH = 200;

/** Deep-clones req.body.params, replacing sensitive/oversized values with a placeholder before logging. */
function redactRequestParams(value: unknown, keyName?: string): unknown {
    if (typeof value === 'string') {
        if (keyName && SENSITIVE_KEY_PATTERN.test(keyName)) return '[REDACTED]';
        if (value.length > MAX_LOGGED_STRING_LENGTH) return `[REDACTED: ${value.length} chars]`;
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactRequestParams(item));
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            result[k] = redactRequestParams(v, k);
        }
        return result;
    }
    return value;
}

/**
 * Express middleware to track MCP requests
 */
export function createTrackingMiddleware(logger: MCPRequestLogger) {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Track all POST requests (covers MCP calls)
        if (req.method !== 'POST') {
            return next();
        }

        const startTime = Date.now();
        const originalJson = res.json.bind(res);
        
        // Extract session from headers or generate one
        const sessionId = req.headers['x-session-id'] as string || 
                         req.headers['x-request-id'] as string ||
                         undefined;
        
        const clientIP = req.ip || 
                req.headers['x-forwarded-for'] as string || 
                req.socket.remoteAddress || 
                'unknown';

        const userAgent = req.headers['user-agent'] || 'unknown';

        // Custom AI agent headers
        const agentId = req.headers['x-agent-id'] as string || undefined;
        const agentName = req.headers['x-agent-name'] as string || undefined;
        const agentVersion = req.headers['x-agent-version'] as string || undefined;
        
        // Intercept res.json to log after response
        res.json = function(data: any) {
            const responseTime = Date.now() - startTime;
            
            // Determine tool name and method from request
            let toolName = 'unknown';
            let requestMethod = req.method;
            let success = res.statusCode >= 200 && res.statusCode < 300;
            let resultSize = 0;
            let errorMessage: string | undefined;

            // Always log MCP JSON-RPC method and params if present
            if (req.body && req.body.method) {
                requestMethod = req.body.method;
                toolName = req.body.method;
                // If tools/call, use params.name for toolName
                if (req.body.method === 'tools/call' && req.body.params?.name) {
                    toolName = req.body.params.name;
                }
            }
            
            // Parse response data
            if (data) {
                if (data.result) {
                    if (Array.isArray(data.result)) {
                        resultSize = data.result.length;
                    } else if (data.result.content) {
                        // MCP tool response format
                        resultSize = Array.isArray(data.result.content) ? data.result.content.length : 1;
                    }
                }
                
                if (data.error) {
                    success = false;
                    errorMessage = data.error.message || JSON.stringify(data.error);
                }
            }
            
            // Log asynchronously (don't wait)
            logger.logRequest({
                sessionId,
                toolName,
                requestMethod,
                requestParams: redactRequestParams(req.body?.params),
                clientIP,
                userAgent,
                agentId,
                agentName,
                agentVersion,
                responseTime,
                success,
                errorMessage,
                resultSize
            }).catch(err => {
                console.error('Failed to log request:', err);
            });
            
            return originalJson(data);
        };
        
        next();
    };
}
