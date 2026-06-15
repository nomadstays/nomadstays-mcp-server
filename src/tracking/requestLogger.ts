import sql from 'mssql';
import { randomUUID } from 'crypto';

interface RequestLogData {
    sessionId?: string;
    toolName: string;
    requestMethod: string;
    requestParams?: any;
    clientIP?: string;
    userAgent?: string;
    agentId?: string;
    agentName?: string;
    agentVersion?: string;
    responseTime?: number;
    success: boolean;
    errorMessage?: string;
    resultSize?: number;
}

export class MCPRequestLogger {
    private connStr: string;

    constructor(connectionString: string) {
        this.connStr = connectionString;
    }

    /**
     * Log an MCP request to the database
     */
    async logRequest(data: RequestLogData): Promise<void> {
        try {
            const pool = await sql.connect(this.connStr);
            await pool.request()
                .input('sessionId', sql.NVarChar(100), data.sessionId || randomUUID())
                .input('toolName', sql.NVarChar(100), data.toolName)
                .input('requestMethod', sql.NVarChar(50), data.requestMethod)
                .input('requestParams', sql.NVarChar(sql.MAX), JSON.stringify(data.requestParams || {}))
                .input('clientIP', sql.NVarChar(50), data.clientIP || 'unknown')
                .input('userAgent', sql.NVarChar(500), data.userAgent || 'unknown')
                .input('agentId', sql.NVarChar(100), data.agentId || null)
                .input('agentName', sql.NVarChar(100), data.agentName || null)
                .input('agentVersion', sql.NVarChar(50), data.agentVersion || null)
                .input('responseTime', sql.Int, data.responseTime || 0)
                .input('success', sql.Bit, data.success ? 1 : 0)
                .input('errorMessage', sql.NVarChar(sql.MAX), data.errorMessage || null)
                .input('resultSize', sql.Int, data.resultSize || 0)
                .query(`
                    INSERT INTO tbMCPRequestTracking 
                    (SessionID, ToolName, RequestMethod, RequestParams, ClientIP, UserAgent, AgentId, AgentName, AgentVersion, 
                     ResponseTime, Success, ErrorMessage, ResultSize)
                    VALUES 
                    (@sessionId, @toolName, @requestMethod, @requestParams, @clientIP, @userAgent, @agentId, @agentName, @agentVersion,
                     @responseTime, @success, @errorMessage, @resultSize)
                `);
            await pool.close();
        } catch (error) {
            // Don't throw - logging failures shouldn't break the MCP server
            console.error('Failed to log MCP request:', error);
        }
    }

    /**
     * Get request statistics for a date range
     */
    async getRequestStats(startDate?: Date, endDate?: Date): Promise<any> {
        try {
            const pool = await sql.connect(this.connStr);
            
            const result = await pool.request()
                .input('startDate', sql.DateTime2, startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
                .input('endDate', sql.DateTime2, endDate || new Date())
                .query(`
                    SELECT 
                        CAST(RequestTimestamp AS DATE) AS RequestDate,
                        ToolName,
                        COUNT(*) AS RequestCount,
                        AVG(ResponseTime) AS AvgResponseTime,
                        SUM(CASE WHEN Success = 1 THEN 1 ELSE 0 END) AS SuccessCount,
                        SUM(CASE WHEN Success = 0 THEN 1 ELSE 0 END) AS ErrorCount
                    FROM tbMCPRequestTracking
                    WHERE RequestTimestamp BETWEEN @startDate AND @endDate
                    GROUP BY CAST(RequestTimestamp AS DATE), ToolName
                    ORDER BY RequestDate DESC, RequestCount DESC
                `);
            
            await pool.close();
            return result.recordset;
        } catch (error) {
            console.error('Failed to get request stats:', error);
            throw error;
        }
    }

    /**
     * Get daily request counts
     */
    async getDailyRequestCounts(days: number = 30): Promise<any> {
        try {
            const pool = await sql.connect(this.connStr);
            
            const result = await pool.request()
                .input('days', sql.Int, days)
                .query(`
                    SELECT 
                        CAST(RequestTimestamp AS DATE) AS RequestDate,
                        COUNT(*) AS TotalRequests,
                        COUNT(DISTINCT SessionID) AS UniqueSessions,
                        COUNT(DISTINCT ToolName) AS UniqueTools,
                        SUM(CASE WHEN Success = 1 THEN 1 ELSE 0 END) AS SuccessfulRequests,
                        SUM(CASE WHEN Success = 0 THEN 1 ELSE 0 END) AS FailedRequests,
                        AVG(ResponseTime) AS AvgResponseTimeMs
                    FROM tbMCPRequestTracking
                    WHERE RequestTimestamp >= DATEADD(day, -@days, GETDATE())
                    GROUP BY CAST(RequestTimestamp AS DATE)
                    ORDER BY RequestDate DESC
                `);
            
            await pool.close();
            return result.recordset;
        } catch (error) {
            console.error('Failed to get daily request counts:', error);
            throw error;
        }
    }

    /**
     * Get most popular tools
     */
    async getPopularTools(days: number = 7): Promise<any> {
        try {
            const pool = await sql.connect(this.connStr);
            
            const result = await pool.request()
                .input('days', sql.Int, days)
                .query(`
                    SELECT TOP 10
                        ToolName,
                        COUNT(*) AS RequestCount,
                        AVG(ResponseTime) AS AvgResponseTime,
                        SUM(CASE WHEN Success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS SuccessRate
                    FROM tbMCPRequestTracking
                    WHERE RequestTimestamp >= DATEADD(day, -@days, GETDATE())
                    GROUP BY ToolName
                    ORDER BY RequestCount DESC
                `);
            
            await pool.close();
            return result.recordset;
        } catch (error) {
            console.error('Failed to get popular tools:', error);
            throw error;
        }
    }
}
