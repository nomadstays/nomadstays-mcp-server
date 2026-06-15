import { Request, Response } from 'express';
import { MCPRequestLogger } from './requestLogger.js';

/**
 * Create stats API endpoints for MCP request tracking
 */
export function createStatsEndpoints(logger: MCPRequestLogger) {
    return {
        /**
         * GET /api/mcp/stats/daily?days=30
         * Returns daily request counts
         */
        async getDailyStats(req: Request, res: Response) {
            try {
                const days = parseInt(req.query.days as string) || 30;
                const stats = await logger.getDailyRequestCounts(days);
                res.json({
                    success: true,
                    data: stats,
                    period: `Last ${days} days`
                });
            } catch (error: any) {
                console.error('Error fetching daily stats:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        },

        /**
         * GET /api/mcp/stats/tools?days=7
         * Returns most popular tools
         */
        async getToolStats(req: Request, res: Response) {
            try {
                const days = parseInt(req.query.days as string) || 7;
                const stats = await logger.getPopularTools(days);
                res.json({
                    success: true,
                    data: stats,
                    period: `Last ${days} days`
                });
            } catch (error: any) {
                console.error('Error fetching tool stats:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        },

        /**
         * GET /api/mcp/stats/detailed?start=2026-01-01&end=2026-02-09
         * Returns detailed request statistics with date range
         */
        async getDetailedStats(req: Request, res: Response) {
            try {
                const startDate = req.query.start ? new Date(req.query.start as string) : undefined;
                const endDate = req.query.end ? new Date(req.query.end as string) : undefined;
                
                const stats = await logger.getRequestStats(startDate, endDate);
                res.json({
                    success: true,
                    data: stats,
                    dateRange: {
                        start: startDate?.toISOString() || 'Last 30 days',
                        end: endDate?.toISOString() || 'Now'
                    }
                });
            } catch (error: any) {
                console.error('Error fetching detailed stats:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    };
}
