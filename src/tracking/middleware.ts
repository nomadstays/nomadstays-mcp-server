import { Request, Response, NextFunction } from 'express';
import { MCPRequestLogger } from './requestLogger.js';

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
                requestParams: req.body?.params,
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
