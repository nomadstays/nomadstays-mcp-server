#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';
import sql from "mssql";
import type { Stay } from "./types/stay.js";

// Detect if we're running in HTTP mode (Coolify container) or stdio mode (MCP Inspector/Client)
const isHttpMode = !!(process.env.PORT || process.env.HTTP_PORT);

// Load environment from .env file manually to avoid dotenv's stdout pollution in stdio mode
// This is critical because any stdout output breaks the JSON-RPC protocol over stdio
// Skip in HTTP mode — env vars come from the host (Coolify/Docker)
if (!isHttpMode) try {
  const envPath = resolve('.env');
  const envContent = readFileSync(envPath, 'utf8');
  
  // Parse .env file manually (simple parser for key=value format)
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) return;
    
    // Parse KEY=VALUE or KEY="VALUE"
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      let value = match[2].trim();
      
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // Only set if not already defined
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
} catch (err: any) {
  // Silently fail if .env doesn't exist
  if (err?.code !== 'ENOENT') {
    console.warn('Failed to load .env file:', err?.message);
  }
}

// Global error handlers for better visibility in container logs
// Only enable in HTTP mode to avoid interfering with stdio JSON-RPC protocol
if (isHttpMode) {
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err && (err as any).stack ? (err as any).stack : String(err));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason && (reason as any).stack ? (reason as any).stack : String(reason));
  });
}

/**
 * NomadStays MCP server that provides access to stay data.
 * It demonstrates core MCP concepts like resources and tools.
 * 
 * Compatible with Claude (via Claude Desktop or API) and ChatGPT/OpenAI models
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { 
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { MCPRequestLogger } from "./tracking/requestLogger.js";
import { createTrackingMiddleware } from "./tracking/middleware.js";
import { createStatsEndpoints } from "./tracking/statsEndpoints.js";
import { runWithRequestAgentToken } from "./tracking/requestTokenContext.js";
import { requestCallsProtectedTool } from "./auth/protectedTools.js";
import { isTokenAcceptable, RESOURCE_URI } from "./auth/introspect.js";
import { mcpEndpointLimiter, isSignupRateLimited, requestCallsSignup } from "./auth/rateLimit.js";
import {
  STAY_RESULTS_TEMPLATE_URI,
  stayResultsWidgetMeta,
  stayResultsToolInvocationMeta,
  stayResultsWidgetHtml,
} from "./widgets/stayResultsWidget.js";
import {
  AVAILABILITY_TEMPLATE_URI,
  availabilityWidgetMeta,
  availabilityToolInvocationMeta,
  availabilityWidgetHtml,
} from "./widgets/availabilityWidget.js";
import {
  BOOKING_TEMPLATE_URI,
  bookingWidgetMeta,
  bookingToolInvocationMeta,
  bookingWidgetHtml,
} from "./widgets/bookingWidget.js";
import {
  LIST_CARDS_TEMPLATE_URI,
  listCardsWidgetMeta,
  listCardsToolInvocationMeta,
  listCardsWidgetHtml,
  buildListCardsStructuredContent,
} from "./widgets/listCardsWidget.js";


/**
 * Compatibility layer for Claude and ChatGPT
 * - Detects client capabilities and adjusts response format accordingly
 * - Ensures tool schemas work with both strict (Claude) and flexible (ChatGPT) parsers
 * - Normalizes error messages for consistent handling across clients
 */
const CompatibilityHelper = {
  /**
   * Validates tool arguments against schema requirements
   * Works with both Claude's strict validation and ChatGPT's flexible parsing
   */
  validateToolArgs(toolName: string, args: any, required: string[]): { valid: boolean; error?: string } {
    if (!args) args = {};
    
    for (const field of required) {
      if (!(field in args) || args[field] === null || args[field] === undefined) {
        return {
          valid: false,
          error: `Missing required argument '${field}' for tool '${toolName}'`
        };
      }
    }
    
    return { valid: true };
  },

  /**
   * Normalizes error messages for both Claude and ChatGPT clients
   */
  formatError(message: string, context?: string): string {
    const prefix = context ? `[${context}] ` : '';
    return prefix + message;
  },

  /**
   * Ensures tool response content is properly formatted for both clients
   */
  formatToolResponse(data: any): { content: Array<{ type: string; text: string }> } {
    return {
      content: [{
        type: "text" as const,
        text: typeof data === 'string' ? data : JSON.stringify(data)
      }]
    };
  }
};

/**
 * Builds a fresh MCP Server with capabilities for resources (to list/read stays) and tools
 * (to query stays). Fully compatible with both Claude and ChatGPT/OpenAI models.
 *
 * IMPORTANT: call this fresh for every /mcp HTTP request (see the handler below) — the SDK's
 * Server.connect() throws "Already connected to a transport" if the same Server instance is
 * connected to a second transport before the first is closed, which under any concurrent
 * traffic on a shared singleton crashed requests essentially at random. Building a new Server
 * (cheap — the tool/resource definitions below are static data, not per-request work) and
 * connecting it to a fresh StreamableHTTPServerTransport per request eliminates that race
 * entirely. Stdio mode (main()'s non-HTTP branch, used by Claude Desktop) still uses a single
 * shared instance further below — that path is genuinely single-connection for its whole
 * process lifetime, so the race doesn't apply there.
 */
function createServer(): Server {
  const server = new Server(
  {
    name: "nomadstays-mcp-server",
    version: "0.7.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    },
  }
);

// Register the "getStaysByCountry" and "getStaysByContinent" tools using setRequestHandler for CallToolRequestSchema
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "getStaysByWiFiSpeed") {
      const minWiFiDownloadSpeed = Number(request.params.arguments?.minWiFiDownloadSpeed) || 10;
      const limit = Number(request.params.arguments?.limit) || 15;
      const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
      let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
      connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
      if (!connStr) {
        throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
      }
      try {
        const { getStaysByWiFiSpeed } = await import('./db/getStaysByWiFiSpeed.js');
        const stays = await getStaysByWiFiSpeed(connStr, { minWiFiDownloadSpeed, limit });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(stays)
          }],
          structuredContent: { stays },
          _meta: stayResultsToolInvocationMeta
        };
      } catch (err: any) {
        throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
      }
    }
  if (request.params.name === "signupNomadStaysAccount") {
    const args = request.params.arguments ?? {};
    const required = ["firstName", "lastName", "email", "telephone", "password", "acceptGdpr"] as const;
    for (const field of required) {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        throw new Error(`Tool 'signupNomadStaysAccount' requires '${field}' argument`);
      }
    }

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.signUp({
        firstName: String(args.firstName),
        lastName: String(args.lastName),
        email: String(args.email),
        telephone: String(args.telephone),
        password: String(args.password),
        acceptGdpr: Boolean(args.acceptGdpr),
      });
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`signupNomadStaysAccount failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStaysByCountry") {
    // Validate required parameter
    const countrycode = request.params.arguments?.countrycode;
    if (!countrycode) {
      throw new Error("Tool 'getStaysByCountry' requires 'countrycode' argument (2-letter code or country name)");
    }
    
    const limit = Number(request.params.arguments?.limit) || 15;

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix port syntax if user pasted incorrectly
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStaysByCountry } = await import('./db/getStaysByCountry.js');
      const stays = await getStaysByCountry(connStr, { country: String(countrycode), limit });

      // Return the stays as a text content item (JSON string) so the tool
      // response validates against the MCP tool result schema.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stays)
        }],
        structuredContent: { stays },
        _meta: stayResultsToolInvocationMeta
      };
    } catch (err: any) {
      // Surface the DB error to the client for easier debugging
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStaysByContinent") {
    // Validate required parameter
    const continent = request.params.arguments?.continent;
    if (!continent) {
      throw new Error("Tool 'getStaysByContinent' requires 'continent' argument (e.g., 'Europe', 'Asia')");
    }
    
    const limit = Number(request.params.arguments?.limit) || 15;

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix port syntax if user pasted incorrectly
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStaysByContinent } = await import('./db/getStaysByContinent.js');
      const stays = await getStaysByContinent(connStr, { continent: String(continent), limit });

      // Return the stays as a text content item (JSON string) so the tool
      // response validates against the MCP tool result schema.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stays)
        }],
        structuredContent: { stays },
        _meta: stayResultsToolInvocationMeta
      };
    } catch (err: any) {
      // Surface the DB error to the client for easier debugging
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStaysByLocation") {
    // Validate required parameter
    const location = request.params.arguments?.location;
    if (!location) {
      throw new Error("Tool 'getStaysByLocation' requires 'location' argument (e.g., 'Paris', 'California', 'Beach')");
    }
    
    const limit = Number(request.params.arguments?.limit) || 15;

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix port syntax if user pasted incorrectly
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStaysByLocation } = await import('./db/getStaysByLocation.js');
      const stays = await getStaysByLocation(connStr, { location: String(location), limit });

      // Return the stays as a text content item (JSON string) so the tool
      // response validates against the MCP tool result schema.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stays)
        }],
        structuredContent: { stays },
        _meta: stayResultsToolInvocationMeta
      };
    } catch (err: any) {
      // Surface the DB error to the client for easier debugging
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "searchHelpCenter") {
    const query = String(request.params.arguments?.query ?? '').trim();
    const limit = Number(request.params.arguments?.limit) || 15;
    const url = new URL('https://help.nomadstays.com/wp-json/wp/v2/knowledgebase');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('_fields', 'title,content,slug');
    if (query) {
      url.searchParams.set('search', query);
    }

    try {
      const response = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
      if (!response.ok) {
        throw new Error(`Help center request failed with status ${response.status} ${response.statusText}`);
      }
      const articles = await response.json();
      const results = Array.isArray(articles) ? articles.slice(0, limit) : [];

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(results)
        }]
      };
    } catch (err: any) {
      throw new Error(`Help center query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getHelpCenterArticle") {
    const id = String(request.params.arguments?.id ?? '').trim();
    if (!id) throw new Error("Tool 'getHelpCenterArticle' requires 'id' argument");

    // Numeric IDs use the direct endpoint; slugs use the ?slug= query param
    const isNumeric = /^\d+$/.test(id);
    const url = isNumeric
      ? `https://help.nomadstays.com/wp-json/wp/v2/knowledgebase/${encodeURIComponent(id)}?_fields=id,title,content,slug,excerpt,categories`
      : `https://help.nomadstays.com/wp-json/wp/v2/knowledgebase?slug=${encodeURIComponent(id)}&_fields=id,title,content,slug,excerpt,categories`;

    try {
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!response.ok) {
        throw new Error(`Help center request failed with status ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      // Slug lookups return an array; unwrap to a single object if possible
      const article = Array.isArray(data) ? (data[0] ?? null) : data;
      if (!article) throw new Error(`No article found with slug: ${id}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(article)
        }]
      };
    } catch (err: any) {
      throw new Error(`Help center article fetch failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "listHelpCenterCategories") {
    const url = 'https://help.nomadstays.com/wp-json/wp/v2/knowledgebase_cat?per_page=100&_fields=id,name,slug,description,count';

    try {
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!response.ok) {
        throw new Error(`Help center request failed with status ${response.status} ${response.statusText}`);
      }
      const categories = await response.json();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(Array.isArray(categories) ? categories : [])
        }]
      };
    } catch (err: any) {
      throw new Error(`Help center categories fetch failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStaysByLifestyle") {
    // Validate required parameter
    const lifestyle = request.params.arguments?.lifestyle;
    if (!lifestyle) {
      throw new Error("Tool 'getStaysByLifestyle' requires 'lifestyle' argument (e.g., 'Digital Nomad', 'Beach', 'City')");
    }
    
    const limit = Number(request.params.arguments?.limit) || 15;

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix port syntax if user pasted incorrectly
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStaysByLifestyle } = await import('./db/getStaysByLifestyle.js');
      const stays = await getStaysByLifestyle(connStr, { lifestyle: String(lifestyle), limit });

      // Return the stays as a text content item (JSON string) so the tool
      // response validates against the MCP tool result schema.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stays)
        }],
        structuredContent: { stays },
        _meta: stayResultsToolInvocationMeta
      };
    } catch (err: any) {
      // Surface the DB error to the client for easier debugging
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }



  if (request.params.name === "getStayByID") {
    const id = request.params.arguments?.id ?? null;
    if (!id) throw new Error("Tool 'getStayByID' requires 'id' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix port syntax if user pasted incorrectly
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStayByID } = await import('./db/getStayByID.js');
      const stay = await getStayByID(connStr, String(id));

      // Return the stay as a text content item (JSON string) so the tool
      // response validates against the MCP tool result schema.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stay)
        }]
      };
    } catch (err: any) {
      // Surface the DB error to the client for easier debugging
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getAllLifestyles") {
    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix port syntax if user pasted incorrectly
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getAllLifestyles } = await import('./db/getAllLifestyles.js');
      const lifestyles = await getAllLifestyles(connStr);

      // Return the lifestyles as a text content item (JSON string) so the tool
      // response validates against the MCP tool result schema.
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(lifestyles)
        }]
      };
    } catch (err: any) {
      // Surface the DB error to the client for easier debugging in dev
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "checkStayAvailability") {
    const stayId = request.params.arguments?.stayId ?? null;
    const checkIn = request.params.arguments?.checkIn ?? null;
    const checkOut = request.params.arguments?.checkOut ?? null;
    const roomType = request.params.arguments?.roomType ?? null;

    if (!stayId) throw new Error("Tool 'checkStayAvailability' requires 'stayId' argument");
    if (!checkIn) throw new Error("Tool 'checkStayAvailability' requires 'checkIn' argument");
    if (!checkOut) throw new Error("Tool 'checkStayAvailability' requires 'checkOut' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { checkStayAvailability } = await import('./db/checkStayAvailability.js');
      const result = await checkStayAvailability(connStr, { 
        stayId: String(stayId), 
        checkIn: String(checkIn), 
        checkOut: String(checkOut), 
        roomType: roomType ? String(roomType) : undefined
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result)
        }],
        structuredContent: result,
        _meta: availabilityToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "findNearestAvailability") {
    const stayId = request.params.arguments?.stayId ?? null;
    const preferredCheckIn = request.params.arguments?.preferredCheckIn ?? null;
    const minLengthOfStay = Number(request.params.arguments?.minLengthOfStay) || null;
    const maxLengthOfStay = request.params.arguments?.maxLengthOfStay ? Number(request.params.arguments.maxLengthOfStay) : undefined;
    const searchWindowDays = request.params.arguments?.searchWindowDays ? Number(request.params.arguments.searchWindowDays) : undefined;

    if (!stayId) throw new Error("Tool 'findNearestAvailability' requires 'stayId' argument");
    if (!preferredCheckIn) throw new Error("Tool 'findNearestAvailability' requires 'preferredCheckIn' argument");
    if (!minLengthOfStay) throw new Error("Tool 'findNearestAvailability' requires 'minLengthOfStay' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { findNearestAvailability } = await import('./db/findNearestAvailability.js');
      const result = await findNearestAvailability(connStr, { 
        stayId: String(stayId), 
        preferredCheckIn: String(preferredCheckIn), 
        minLengthOfStay, 
        maxLengthOfStay, 
        searchWindowDays 
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result)
        }]
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getAvailabilityByMonth") {
    const stayId = request.params.arguments?.stayId ?? null;
    const year = Number(request.params.arguments?.year) || null;
    const month = Number(request.params.arguments?.month) || null;
    const minLengthOfStay = Number(request.params.arguments?.minLengthOfStay) || null;

    if (!stayId) throw new Error("Tool 'getAvailabilityByMonth' requires 'stayId' argument");
    if (!year) throw new Error("Tool 'getAvailabilityByMonth' requires 'year' argument");
    if (!month) throw new Error("Tool 'getAvailabilityByMonth' requires 'month' argument");
    if (!minLengthOfStay) throw new Error("Tool 'getAvailabilityByMonth' requires 'minLengthOfStay' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getAvailabilityByMonth } = await import('./db/getAvailabilityByMonth.js');
      const result = await getAvailabilityByMonth(connStr, { 
        stayId: String(stayId), 
        year, 
        month, 
        minLengthOfStay 
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result)
        }]
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getRoomAvailability") {
    const roomId = request.params.arguments?.roomId ?? null;
    const checkIn = request.params.arguments?.checkIn ?? null;
    const checkOut = request.params.arguments?.checkOut ?? null;

    if (!roomId && roomId !== 0) throw new Error("Tool 'getRoomAvailability' requires 'roomId' argument");
    if (!checkIn) throw new Error("Tool 'getRoomAvailability' requires 'checkIn' argument");
    if (!checkOut) throw new Error("Tool 'getRoomAvailability' requires 'checkOut' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getRoomAvailability } = await import('./db/getRoomAvailability.js');
      const result = await getRoomAvailability(connStr, { 
        roomId: String(roomId), 
        checkIn: String(checkIn), 
        checkOut: String(checkOut) 
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result)
        }]
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStaysByBudget") {
    const countryCode = request.params.arguments?.countryCode ?? null;
    const durationDays = Number(request.params.arguments?.durationDays) || null;
    const maxPrice = Number(request.params.arguments?.maxPrice) || null;
    const currency = request.params.arguments?.currency ?? null;
    const checkInDate = request.params.arguments?.checkInDate ?? null;
    const limit = Number(request.params.arguments?.limit) || 15;

    if (!durationDays) throw new Error("Tool 'getStaysByBudget' requires 'durationDays' argument");
    if (!maxPrice) throw new Error("Tool 'getStaysByBudget' requires 'maxPrice' argument");
    if (!currency) throw new Error("Tool 'getStaysByBudget' requires 'currency' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStaysByBudget } = await import('./db/getStaysByBudget.js');
      const stays = await getStaysByBudget(connStr, { 
        countryCode: countryCode ? String(countryCode) : null, 
        durationDays, 
        maxPrice, 
        currency: String(currency), 
        checkInDate: checkInDate ? String(checkInDate) : null,
        limit 
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stays)
        }],
        structuredContent: { stays },
        _meta: stayResultsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getRoomAmenities") {
    const roomId = request.params.arguments?.roomId ?? null;

    if (!roomId && roomId !== 0) throw new Error("Tool 'getRoomAmenities' requires 'roomId' argument");

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getRoomAmenities } = await import('./db/getRoomAmenities.js');
      const result = await getRoomAmenities(connStr, String(roomId));

      return {
        content: [{
          type: "text" as const,
          text: result.text
        }]
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getAllAmenities") {

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getAllAmenities } = await import('./db/getAllAmenities.js');
      const result = await getAllAmenities(connStr);

      return {
        content: [{
          type: "text" as const,
          text: result.text
        }]
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStaysByAmenities") {
    const amenities = request.params.arguments?.amenities ?? null;
    const matchType = String(request.params.arguments?.matchType ?? 'any');
    const minWifiSpeed = Number(request.params.arguments?.minWifiSpeed) || 0;
    const limit = Number(request.params.arguments?.limit) || 25;

    if (!amenities || !Array.isArray(amenities) || amenities.length === 0) {
      throw new Error("Tool 'getStaysByAmenities' requires 'amenities' argument (array of amenity names)");
    }
    if (!['any', 'all'].includes(matchType)) {
      throw new Error("Tool 'getStaysByAmenities' requires 'matchType' to be either 'any' or 'all'");
    }

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) {
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query the database");
    }

    try {
      const { getStaysByAmenities } = await import('./db/getStaysByAmenities.js');
      const stays = await getStaysByAmenities(connStr, { 
        amenities: amenities as string[], 
        matchType: matchType as 'any' | 'all',
        minWifiSpeed,
        limit 
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stays)
        }],
        structuredContent: { stays },
        _meta: stayResultsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  // ── Owner-scoped lookup tools (require NOMADSTAYS_MCP_AGENT_TOKEN) ────────
  // Pair with the write tools below so an agent can show the host their current
  // values before changing anything, rather than guessing or blanking fields.

  if (request.params.name === "getMyStays") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getMyStays();
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: buildListCardsStructuredContent(result, {
          titleField: "title",
          booleanFields: ["listed"]
        }),
        _meta: listCardsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`getMyStays failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayDetail") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayDetail' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayDetail(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayDetail failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayOnboardingStatus") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayOnboardingStatus' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getOnboardingStatus(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayOnboardingStatus failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayRooms") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayRooms' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getRooms(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayRooms failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayPackages") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayPackages' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getPackages(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayPackages failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayOrganisationalData") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayOrganisationalData' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayOrganisational(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayOrganisationalData failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyBusinessProfile") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getBusinessProfile();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyBusinessProfile failed: ${err?.message ?? String(err)}`);
    }
  }

  // ── Write tools (require NOMADSTAYS_MCP_AGENT_TOKEN) ──────────────────────

  if (request.params.name === "updateStayDetail") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'updateStayDetail' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { title, description } = request.params.arguments ?? {};
    try {
      await mcpAgentClient.patchStayDetail(String(stayId), { title, description });
      return CompatibilityHelper.formatToolResponse({ updated: true, stayId });
    } catch (err: any) {
      throw new Error(`updateStayDetail failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "createStayRoom") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'createStayRoom' requires 'stayId' argument");
    const { roomTitle } = request.params.arguments ?? {};
    if (!roomTitle) throw new Error("Tool 'createStayRoom' requires 'roomTitle' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      const result = await mcpAgentClient.createRoom(String(stayId), body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`createStayRoom failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "updateStayRoom") {
    const stayId = request.params.arguments?.stayId ?? null;
    const roomId = request.params.arguments?.roomId ?? null;
    if (!stayId) throw new Error("Tool 'updateStayRoom' requires 'stayId' argument");
    if (!roomId) throw new Error("Tool 'updateStayRoom' requires 'roomId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, roomId: _r, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      await mcpAgentClient.patchRoom(String(stayId), String(roomId), body);
      return CompatibilityHelper.formatToolResponse({ updated: true, stayId, roomId });
    } catch (err: any) {
      throw new Error(`updateStayRoom failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "deleteStayRoom") {
    const stayId = request.params.arguments?.stayId ?? null;
    const roomId = request.params.arguments?.roomId ?? null;
    if (!stayId) throw new Error("Tool 'deleteStayRoom' requires 'stayId' argument");
    if (!roomId) throw new Error("Tool 'deleteStayRoom' requires 'roomId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.deleteRoom(String(stayId), String(roomId));
      return CompatibilityHelper.formatToolResponse({ deleted: true, stayId, roomId });
    } catch (err: any) {
      throw new Error(`deleteStayRoom failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getRoomTypeOptions") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getRoomTypeOptions' requires 'stayId' argument (valid room types depend on whether the Stay is boutique or standard, and — for standard Stays — which types are already in use)");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getRoomTypesForStay(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getRoomTypeOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getRoomFacilityOptions") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getRoomFacilities();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getRoomFacilityOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "deleteRoomPhoto") {
    const stayId = request.params.arguments?.stayId ?? null;
    const roomId = request.params.arguments?.roomId ?? null;
    const roomArea = request.params.arguments?.roomArea ?? null;
    const fileName = request.params.arguments?.fileName ?? null;
    if (!stayId) throw new Error("Tool 'deleteRoomPhoto' requires 'stayId' argument");
    if (!roomId) throw new Error("Tool 'deleteRoomPhoto' requires 'roomId' argument");
    if (!roomArea) throw new Error("Tool 'deleteRoomPhoto' requires 'roomArea' argument ('photos' or 'workspace')");
    if (!fileName) throw new Error("Tool 'deleteRoomPhoto' requires 'fileName' argument (call getMyStayRooms to find it)");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.deleteRoomPhoto(String(stayId), String(roomId), String(roomArea), String(fileName));
      return CompatibilityHelper.formatToolResponse({ deleted: true, stayId, roomId, roomArea, fileName });
    } catch (err: any) {
      throw new Error(`deleteRoomPhoto failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "reorderRoomPhotos") {
    const stayId = request.params.arguments?.stayId ?? null;
    const roomId = request.params.arguments?.roomId ?? null;
    const roomArea = request.params.arguments?.roomArea ?? null;
    const fileNames = request.params.arguments?.fileNames ?? null;
    if (!stayId) throw new Error("Tool 'reorderRoomPhotos' requires 'stayId' argument");
    if (!roomId) throw new Error("Tool 'reorderRoomPhotos' requires 'roomId' argument");
    if (!roomArea) throw new Error("Tool 'reorderRoomPhotos' requires 'roomArea' argument ('photos' or 'workspace')");
    if (!Array.isArray(fileNames)) {
      throw new Error("Tool 'reorderRoomPhotos' requires 'fileNames' as an array — the full room gallery in the desired order (call getMyStayRooms first)");
    }
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.reorderRoomPhotos(String(stayId), String(roomId), String(roomArea), { fileNames });
      return CompatibilityHelper.formatToolResponse({ reordered: true, stayId, roomId, roomArea });
    } catch (err: any) {
      throw new Error(`reorderRoomPhotos failed: ${err?.message ?? String(err)}`);
    }
  }


  if (request.params.name === "createStayPackage") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'createStayPackage' requires 'stayId' argument");
    const { packageName } = request.params.arguments ?? {};
    if (!packageName) throw new Error("Tool 'createStayPackage' requires 'packageName' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      const result = await mcpAgentClient.createPackage(String(stayId), body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`createStayPackage failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "updateStayPackage") {
    const stayId = request.params.arguments?.stayId ?? null;
    const packageId = request.params.arguments?.packageId ?? null;
    if (!stayId) throw new Error("Tool 'updateStayPackage' requires 'stayId' argument");
    if (!packageId) throw new Error("Tool 'updateStayPackage' requires 'packageId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, packageId: _p, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      await mcpAgentClient.patchPackage(String(stayId), String(packageId), body);
      return CompatibilityHelper.formatToolResponse({ updated: true, stayId, packageId });
    } catch (err: any) {
      throw new Error(`updateStayPackage failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "deleteStayPackage") {
    const stayId = request.params.arguments?.stayId ?? null;
    const packageId = request.params.arguments?.packageId ?? null;
    if (!stayId) throw new Error("Tool 'deleteStayPackage' requires 'stayId' argument");
    if (!packageId) throw new Error("Tool 'deleteStayPackage' requires 'packageId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.deletePackage(String(stayId), String(packageId));
      return CompatibilityHelper.formatToolResponse({ deleted: true, stayId, packageId });
    } catch (err: any) {
      throw new Error(`deleteStayPackage failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getCurrencyOptions") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getCurrencies();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getCurrencyOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "updateStayOrganisationalData") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'updateStayOrganisationalData' requires 'stayId' argument");

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      await mcpAgentClient.patchStayOrganisational(String(stayId), body);
      return CompatibilityHelper.formatToolResponse({ updated: true, stayId });
    } catch (err: any) {
      throw new Error(`updateStayOrganisationalData failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "updateHostBusinessProfile") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const body = request.params.arguments as Record<string, unknown>;
    try {
      await mcpAgentClient.patchBusinessProfile(body);
      return CompatibilityHelper.formatToolResponse({ updated: true });
    } catch (err: any) {
      throw new Error(`updateHostBusinessProfile failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "uploadStayPhoto") {
    const stayId = request.params.arguments?.stayId ?? null;
    const area = request.params.arguments?.area ?? null;
    const url = request.params.arguments?.url ?? null;
    const base64 = request.params.arguments?.base64 ?? null;
    if (!stayId) throw new Error("Tool 'uploadStayPhoto' requires 'stayId' argument");
    if (!area) throw new Error("Tool 'uploadStayPhoto' requires 'area' argument (listing, main, workspace, host, or room)");
    if (!url && !base64) throw new Error("Tool 'uploadStayPhoto' requires either 'url' or 'base64'");
    if (url && base64) throw new Error("Tool 'uploadStayPhoto' accepts only one of 'url' or 'base64', not both");
    if (area === 'room' && !request.params.arguments?.roomId) {
      throw new Error("Tool 'uploadStayPhoto' requires 'roomId' when area is 'room' (call getMyStayRooms to find it)");
    }

    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      const result = await mcpAgentClient.uploadPhoto(String(stayId), body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`uploadStayPhoto failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayContacts") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayContacts' requires 'stayId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayContacts(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayContacts failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "updateStayContacts") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'updateStayContacts' requires 'stayId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    const { stayId: _s, ...body } = request.params.arguments as Record<string, unknown>;
    try {
      await mcpAgentClient.patchStayContacts(String(stayId), body);
      return CompatibilityHelper.formatToolResponse({ updated: true, stayId });
    } catch (err: any) {
      throw new Error(`updateStayContacts failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayFacilities") {
    const stayId = request.params.arguments?.stayId ?? null;
    const group = request.params.arguments?.group ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayFacilities' requires 'stayId' argument");
    if (!group) throw new Error("Tool 'getMyStayFacilities' requires 'group' argument (call getFacilityGroups to see valid group names)");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayFacilities(String(stayId), String(group));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayFacilities failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "updateStayFacilities") {
    const stayId = request.params.arguments?.stayId ?? null;
    const group = request.params.arguments?.group ?? null;
    const facilityDetailIds = request.params.arguments?.facilityDetailIds ?? null;
    if (!stayId) throw new Error("Tool 'updateStayFacilities' requires 'stayId' argument");
    if (!group) throw new Error("Tool 'updateStayFacilities' requires 'group' argument");
    if (!Array.isArray(facilityDetailIds)) {
      throw new Error("Tool 'updateStayFacilities' requires 'facilityDetailIds' as an array (the FULL replacement list of selected IDs — call getMyStayFacilities first to see current selections and valid IDs)");
    }
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.patchStayFacilities(String(stayId), String(group), { facilityDetailIds });
      return CompatibilityHelper.formatToolResponse({ updated: true, stayId, group });
    } catch (err: any) {
      throw new Error(`updateStayFacilities failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getFacilityGroups") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getFacilityGroups();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getFacilityGroups failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStayTypeOptions") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayTypes();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getStayTypeOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getCountryOptions") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getCountries();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getCountryOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getCancellationPolicyOptions") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getCancellationPolicies();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getCancellationPolicyOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getAdditionalInformationOptions") {
    const filterName = request.params.arguments?.filterName ?? null;
    if (!filterName) throw new Error("Tool 'getAdditionalInformationOptions' requires 'filterName' (one of: Children Allowed, Pets Allowed, Parking)");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getAdditionalInformationOptions(String(filterName));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getAdditionalInformationOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getBusinessModelOptions") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getBusinessModels();
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getBusinessModelOptions failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getMyStayPhotos") {
    const stayId = request.params.arguments?.stayId ?? null;
    if (!stayId) throw new Error("Tool 'getMyStayPhotos' requires 'stayId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayPhotos(String(stayId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getMyStayPhotos failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "deleteStayPhoto") {
    const stayId = request.params.arguments?.stayId ?? null;
    const area = request.params.arguments?.area ?? null;
    const fileName = request.params.arguments?.fileName ?? null;
    if (!stayId) throw new Error("Tool 'deleteStayPhoto' requires 'stayId' argument");
    if (!area) throw new Error("Tool 'deleteStayPhoto' requires 'area' argument (listing, main, workspace, or host)");
    if (!fileName) throw new Error("Tool 'deleteStayPhoto' requires 'fileName' argument (call getMyStayPhotos to find it)");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.deleteStayPhoto(String(stayId), String(area), String(fileName));
      return CompatibilityHelper.formatToolResponse({ deleted: true, stayId, area, fileName });
    } catch (err: any) {
      throw new Error(`deleteStayPhoto failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "reorderStayPhotos") {
    const stayId = request.params.arguments?.stayId ?? null;
    const area = request.params.arguments?.area ?? null;
    const fileNames = request.params.arguments?.fileNames ?? null;
    if (!stayId) throw new Error("Tool 'reorderStayPhotos' requires 'stayId' argument");
    if (!area) throw new Error("Tool 'reorderStayPhotos' requires 'area' argument ('listing' or 'workspace')");
    if (!Array.isArray(fileNames)) {
      throw new Error("Tool 'reorderStayPhotos' requires 'fileNames' as an array — the full gallery in the desired order (call getMyStayPhotos first to see current filenames)");
    }
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      await mcpAgentClient.reorderStayPhotos(String(stayId), String(area), { fileNames });
      return CompatibilityHelper.formatToolResponse({ reordered: true, stayId, area });
    } catch (err: any) {
      throw new Error(`reorderStayPhotos failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getProductInfo") {
    const productId = request.params.arguments?.productId ?? null;
    if (productId == null) throw new Error("Tool 'getProductInfo' requires 'productId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getProductInfo(String(productId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getProductInfo failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "purchaseProduct") {
    const productId = request.params.arguments?.productId ?? null;
    const applicationId = request.params.arguments?.applicationId ?? undefined;
    if (productId == null) throw new Error("Tool 'purchaseProduct' requires 'productId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.purchaseProduct(String(productId), applicationId != null ? String(applicationId) : undefined);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`purchaseProduct failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getPurchaseStatus") {
    const saleId = request.params.arguments?.saleId ?? null;
    if (!saleId) throw new Error("Tool 'getPurchaseStatus' requires 'saleId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getPurchaseStatus(String(saleId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getPurchaseStatus failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "listStayApplications") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.listStayApplications();
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: buildListCardsStructuredContent(result, {
          titleField: "stayName",
          booleanFields: ["submitted", "accepted"]
        }),
        _meta: listCardsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`listStayApplications failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getStayApplication") {
    const applicationId = request.params.arguments?.applicationId ?? null;
    if (applicationId == null) throw new Error("Tool 'getStayApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getStayApplication(String(applicationId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getStayApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "createStayApplication") {
    const { applicationId, ...body } = request.params.arguments ?? {};
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.createStayApplication(body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`createStayApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "saveStayApplication") {
    const { applicationId, ...body } = request.params.arguments ?? {};
    if (applicationId == null) throw new Error("Tool 'saveStayApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.saveStayApplication(String(applicationId), body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`saveStayApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "submitStayApplication") {
    const applicationId = request.params.arguments?.applicationId ?? null;
    if (applicationId == null) throw new Error("Tool 'submitStayApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.submitStayApplication(String(applicationId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`submitStayApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "listExperienceApplications") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.listExperienceApplications();
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: buildListCardsStructuredContent(result, {
          titleField: "experienceName",
          booleanFields: ["submitted", "accepted"]
        }),
        _meta: listCardsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`listExperienceApplications failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getExperienceApplication") {
    const applicationId = request.params.arguments?.applicationId ?? null;
    if (applicationId == null) throw new Error("Tool 'getExperienceApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getExperienceApplication(String(applicationId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getExperienceApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "createExperienceApplication") {
    const { applicationId, ...body } = request.params.arguments ?? {};
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.createExperienceApplication(body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`createExperienceApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "saveExperienceApplication") {
    const { applicationId, ...body } = request.params.arguments ?? {};
    if (applicationId == null) throw new Error("Tool 'saveExperienceApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.saveExperienceApplication(String(applicationId), body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`saveExperienceApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "submitExperienceApplication") {
    const applicationId = request.params.arguments?.applicationId ?? null;
    if (applicationId == null) throw new Error("Tool 'submitExperienceApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.submitExperienceApplication(String(applicationId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`submitExperienceApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "quoteStayBooking") {
    const packageId = request.params.arguments?.packageId ?? null;
    const checkIn = request.params.arguments?.checkIn ?? null;
    const checkOut = request.params.arguments?.checkOut ?? null;
    if (packageId == null) throw new Error("Tool 'quoteStayBooking' requires 'packageId' argument");
    if (!checkIn) throw new Error("Tool 'quoteStayBooking' requires 'checkIn' argument");
    if (!checkOut) throw new Error("Tool 'quoteStayBooking' requires 'checkOut' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.quoteStayBooking({
        packageId: String(packageId),
        checkIn: String(checkIn),
        checkOut: String(checkOut),
        rooms: request.params.arguments?.rooms != null ? Number(request.params.arguments.rooms) : undefined,
        adults: request.params.arguments?.adults != null ? Number(request.params.arguments.adults) : undefined,
        children: request.params.arguments?.children != null ? Number(request.params.arguments.children) : undefined,
        pets: request.params.arguments?.pets != null ? Number(request.params.arguments.pets) : undefined,
      });
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: result,
        _meta: bookingToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`quoteStayBooking failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "bookStay") {
    const quoteId = request.params.arguments?.quoteId ?? null;
    if (!quoteId) throw new Error("Tool 'bookStay' requires 'quoteId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.bookStay({
        quoteId: String(quoteId),
        contactName: request.params.arguments?.contactName != null ? String(request.params.arguments.contactName) : undefined,
        contactEmail: request.params.arguments?.contactEmail != null ? String(request.params.arguments.contactEmail) : undefined,
        contactPhone: request.params.arguments?.contactPhone != null ? String(request.params.arguments.contactPhone) : undefined,
        specialRequest: request.params.arguments?.specialRequest != null ? String(request.params.arguments.specialRequest) : undefined,
      });
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: result,
        _meta: bookingToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`bookStay failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getBookingStatus") {
    const pnr = request.params.arguments?.pnr ?? null;
    if (!pnr) throw new Error("Tool 'getBookingStatus' requires 'pnr' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getBookingStatus(String(pnr));
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: result,
        _meta: bookingToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`getBookingStatus failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "listMyBookings") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.listMyBookings();
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: buildListCardsStructuredContent(result, {
          titleField: "stayTitle",
          statusField: "status",
          actionUrlField: "checkoutUrl",
          actionLabel: "Complete payment"
        }),
        _meta: listCardsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`listMyBookings failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "listCoworkingApplications") {
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.listCoworkingApplications();
      return {
        ...CompatibilityHelper.formatToolResponse(result),
        structuredContent: buildListCardsStructuredContent(result, {
          titleField: "coworkingName",
          booleanFields: ["submitted", "accepted"]
        }),
        _meta: listCardsToolInvocationMeta
      };
    } catch (err: any) {
      throw new Error(`listCoworkingApplications failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "getCoworkingApplication") {
    const applicationId = request.params.arguments?.applicationId ?? null;
    if (applicationId == null) throw new Error("Tool 'getCoworkingApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.getCoworkingApplication(String(applicationId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`getCoworkingApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "createCoworkingApplication") {
    const { applicationId, ...body } = request.params.arguments ?? {};
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.createCoworkingApplication(body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`createCoworkingApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "saveCoworkingApplication") {
    const { applicationId, ...body } = request.params.arguments ?? {};
    if (applicationId == null) throw new Error("Tool 'saveCoworkingApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.saveCoworkingApplication(String(applicationId), body);
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`saveCoworkingApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  if (request.params.name === "submitCoworkingApplication") {
    const applicationId = request.params.arguments?.applicationId ?? null;
    if (applicationId == null) throw new Error("Tool 'submitCoworkingApplication' requires 'applicationId' argument");
    const { mcpAgentClient } = await import('./db/mcpAgentClient.js');
    try {
      const result = await mcpAgentClient.submitCoworkingApplication(String(applicationId));
      return CompatibilityHelper.formatToolResponse(result);
    } catch (err: any) {
      throw new Error(`submitCoworkingApplication failed: ${err?.message ?? String(err)}`);
    }
  }

  throw new Error("Unknown tool");
});

/**
 * Handler for listing available stays as resources.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Apps SDK widget templates — always listed, independent of DB connectivity
  const widgetResources = [
    {
      uri: STAY_RESULTS_TEMPLATE_URI,
      mimeType: "text/html+skybridge",
      name: "Stay results",
      description: "Stay results widget markup",
      _meta: stayResultsWidgetMeta,
    },
    {
      uri: AVAILABILITY_TEMPLATE_URI,
      mimeType: "text/html+skybridge",
      name: "Availability",
      description: "Stay availability widget markup",
      _meta: availabilityWidgetMeta,
    },
    {
      uri: BOOKING_TEMPLATE_URI,
      mimeType: "text/html+skybridge",
      name: "Booking",
      description: "Booking quote/checkout/status widget markup",
      _meta: bookingWidgetMeta,
    },
    {
      uri: LIST_CARDS_TEMPLATE_URI,
      mimeType: "text/html+skybridge",
      name: "List cards",
      description: "Generic list-of-records widget markup",
      _meta: listCardsWidgetMeta,
    },
  ];

  // Try to include stays from DB if a connection is configured
  const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
  let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
  // strip surrounding quotes and fix common port syntax mistakes
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
  if (!connStr) {
    return { resources: widgetResources };
  }

  try {
    const { getStaysByCountry } = await import('./db/getStaysByCountry.js');
    // Only log in HTTP mode to avoid interfering with stdio JSON-RPC protocol
    if (isHttpMode) {
      console.error('Listing stays via DB (masked): %s', connStr.replace(/Password=[^;]*/i, 'Password=***'));
    }
    const stays = await getStaysByCountry(connStr, { limit: 15 });

    const stayResources = stays.map(s => {
      const id = s.StayId ?? s.EntryId ?? null;
      if (!id) {
        if (isHttpMode) {
          console.warn('Skipping stay with missing id', s?.Title ?? '(no title)');
        }
        return null;
      }

      return {
        uri: `stay:///${id}`,
        mimeType: "application/json",
        name: String(s.Title ?? `Stay ${id}`),
        stayId: s.StayId ?? s.EntryId ?? null,
        description: String(s.Description ?? `${s.City ?? ''}${s.GeoLat != null && s.GeoLng != null ? ` (lat: ${s.GeoLat}, lon: ${s.GeoLng})` : ''}`),
        image: s.OgImage ?? null,
        address: s.Address ? { streetAddress: s.Address, addressLocality: s.City ?? '', addressRegion: s.State ?? '', postalCode: s.PostCode ?? '', addressCountry: s.CountryCode2Alpha ?? '' } : null,
        geo: (s.GeoLat != null && s.GeoLng != null) ? { '@type': 'GeoCoordinates', latitude: Number(s.GeoLat), longitude: Number(s.GeoLng) } : null,
        numberOfRooms: s.NumberOfRooms ?? null,
        priceRange: s.priceRange ?? null,
        priceCurrency: s.priceCurrency ?? null,
        amenityFeature: s.AmenityFeatures ?? null,
        petsAllowed: s.PetsAllowed ?? null
      };
    }).filter(Boolean);

    return { resources: [...widgetResources, ...stayResources] };
  } catch (err: any) {
    // If DB query fails, still surface the widget resources (don't hard-fail listing)
    console.error('Failed to list stays for resources:', err?.message ?? String(err));
    return { resources: widgetResources };
  }
});

/**
 * Handler for reading the contents of a specific stay.
 * Takes a stay:// URI and returns the stay content as JSON.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (!request.params || !request.params.uri) throw new Error("ReadResource request missing 'uri' parameter");
  let url: URL;
  try {
    url = new URL(request.params.uri);
  } catch (err) {
    throw new Error(`Invalid resource URI: ${String(request.params.uri)}`);
  }

  // Apps SDK widget templates (ui://widget/...) — self-contained HTML, no DB lookup
  if (request.params.uri === STAY_RESULTS_TEMPLATE_URI) {
    return {
      contents: [{
        uri: STAY_RESULTS_TEMPLATE_URI,
        mimeType: "text/html+skybridge",
        text: stayResultsWidgetHtml,
        _meta: stayResultsWidgetMeta,
      }],
    };
  }

  if (request.params.uri === AVAILABILITY_TEMPLATE_URI) {
    return {
      contents: [{
        uri: AVAILABILITY_TEMPLATE_URI,
        mimeType: "text/html+skybridge",
        text: availabilityWidgetHtml,
        _meta: availabilityWidgetMeta,
      }],
    };
  }

  if (request.params.uri === BOOKING_TEMPLATE_URI) {
    return {
      contents: [{
        uri: BOOKING_TEMPLATE_URI,
        mimeType: "text/html+skybridge",
        text: bookingWidgetHtml,
        _meta: bookingWidgetMeta,
      }],
    };
  }

  if (request.params.uri === LIST_CARDS_TEMPLATE_URI) {
    return {
      contents: [{
        uri: LIST_CARDS_TEMPLATE_URI,
        mimeType: "text/html+skybridge",
        text: listCardsWidgetHtml,
        _meta: listCardsWidgetMeta,
      }],
    };
  }

  const id = url.pathname.replace(/^\//, '');

  // Validate stay id early to avoid misleading "Stay undefined not found" errors
  if (url.protocol === 'stay:') {
    if (!id || id === 'undefined') throw new Error(`Invalid stay id: ${String(id)}`);

    const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
    let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
    // strip surrounding quotes and fix common port syntax mistakes
    connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
    if (!connStr) throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to read stays");

    try {
      const { getStayByID } = await import('./db/getStayByID.js');
      const stay = await getStayByID(connStr, id);
      if (!stay) throw new Error(`Stay ${id} not found`);

      const contents: any[] = [{
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(stay),
          data: stay,
          summary: (stay as any).summary ?? { title: (stay as any).Title ?? null, city: (stay as any).City ?? null, lat: (stay as any).GeoLat ?? null, lon: (stay as any).GeoLng ?? null, priceRange: (stay as any).priceRange ?? null, url: (stay as any).URL ?? null, stayId: (stay as any).StayId ?? null }
        }];

      // If we built JSON-LD for this stay, include it as an additional content item
      if ((stay as any).jsonLd) {
        contents.push({
          uri: request.params.uri,
          mimeType: "application/ld+json",
          text: JSON.stringify((stay as any).jsonLd),
          data: (stay as any).jsonLd
        });
      }

      return { contents };
    } catch (err: any) {
      throw new Error(`DB read failed: ${err?.message ?? String(err)}`);
    }
  }

  throw new Error(`Unknown resource type: ${url.protocol}`);
});

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "getStayByID",
        description: "Returns full details for a single stay. The id parameter searches both EntryId and StayId fields.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stay identifier (searches the EntryId field)" }
          },
          required: ["id"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "signupNomadStaysAccount",
        description: "Creates a new NomadStays account on behalf of a person who does not have one yet. No authentication required — this is how an AI agent gets a person started. The account is created but inactive until the person clicks the confirmation link sent to their email; this call returns no session or token, so the agent cannot sign in or act as the user itself. Once confirmed, the person can log in at nomadstays.com/Account/Login and request their own MCP bearer token or OAuth grant to let an agent manage their account/listings going forward.",
        inputSchema: {
          type: "object",
          properties: {
            firstName: { type: "string", description: "The person's first name" },
            lastName: { type: "string", description: "The person's last name" },
            email: { type: "string", description: "A real email address the person controls — the confirmation link is sent here and the account stays inactive until it's clicked" },
            telephone: { type: "string", description: "Contact telephone number" },
            password: { type: "string", description: "Account password, minimum 6 characters" },
            acceptGdpr: { type: "boolean", description: "Must be true — the person has agreed to NomadStays' GDPR terms" }
          },
          required: ["firstName", "lastName", "email", "telephone", "password", "acceptGdpr"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStaysByCountry",
        description: "Returns stays from the NomadStays database. Search by 2-letter country code (e.g., 'MA', 'US') or country name (e.g., 'Antigua' matches 'Antigua and Barbuda')",
        inputSchema: {
          type: "object",
          properties: {
            countrycode: {
              type: "string",
              description: "2-letter country code (e.g., 'MA', 'US') or partial country name (e.g., 'Antigua')"
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: ["countrycode"]
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStaysByContinent",
        description: "Returns stays from the NomadStays database filtered by continent. Search by continent name (e.g., 'Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania')",
        inputSchema: {
          type: "object",
          properties: {
            continent: {
              type: "string",
              description: "Continent name or partial match (e.g., 'Europe', 'Asia', 'Africa')"
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: ["continent"]
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStaysByLocation",
        description: "Returns stays from the NomadStays database that match a location search term. Searches across City, State, location_name, location_country, and location_description fields. Use this for flexible location searches (e.g., 'Paris', 'California', 'Beach', 'Mountain')",
        inputSchema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "Location search term to match against City, State, location_name, location_country, or location_description (e.g., 'Paris', 'California', 'Beach', 'Mountain')"
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: ["location"]
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "searchHelpCenter",
        description: "Search NomadStays Help Center articles from the public knowledgebase endpoint and return matching title/content/slug entries.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search term to match against Help Center knowledgebase articles"
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: []
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getHelpCenterArticle",
        description: "Fetch a specific NomadStays Help Center article by its ID. Returns the full article content, title, slug, and categories.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The WordPress post ID of the Help Center article (e.g., '123')"
            }
          },
          required: ["id"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "listHelpCenterCategories",
        description: "List all available NomadStays Help Center categories. Returns category ID, name, slug, description, and article count for each category.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStaysByLifestyle",
        description: "Returns stays from the NomadStays database filtered by lifestyle/genre category (e.g., 'Digital Nomad', 'Beach Life', 'City Living', 'Mountain Retreat'). Each stay can belong to multiple lifestyle categories.",
        inputSchema: {
          type: "object",
          properties: {
            lifestyle: { 
              type: "string",
              description: "Lifestyle/genre category name or partial match (e.g., 'Digital Nomad', 'Beach', 'City'). Use getAllLifestyles tool to see all available categories."
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: ["lifestyle"]
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getStaysByBudget",
        description: "Search for stays that fit within a budget for a given duration. Country is OPTIONAL - can search globally or filter by specific country. Perfect for queries like 'Find me somewhere to stay for 1 month under EUR 1000' or 'Find me a place in Spain for 1 month under EUR 1000'.",
        inputSchema: {
          type: "object",
          properties: {
            countryCode: {
              type: "string",
              description: "OPTIONAL: 2-letter country code (e.g., 'ES', 'PT') or country name (e.g., 'Spain'). If omitted, searches all countries globally."
            },
            durationDays: {
              type: "number",
              description: "Duration of stay in days (e.g., 30 for 1 month, 90 for 3 months)"
            },
            maxPrice: {
              type: "number",
              description: "Maximum price for the entire duration (e.g., 1000 for EUR 1000)"
            },
            currency: {
              type: "string",
              description: "Currency code (e.g., 'EUR', 'USD', 'GBP')"
            },
            checkInDate: {
              type: "string",
              description: "OPTIONAL: Check-in date. Can be a full date (e.g., '2026-05-15'), a month name (e.g., 'May' ? uses May 1st), or omit for today (2026-01-19)"
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: ["durationDays", "maxPrice", "currency"]
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getStaysByAmenities",
        description: "Find all stays that have specific amenities. Searches both stay-level amenities (referenced by tbStayFacilities) and room-level amenities (referenced by tbRoomFacilities). Use matchType 'any' to find stays with at least one amenity, or 'all' to find stays with all requested amenities. Can optionally filter by minimum WiFi download speed.",
        inputSchema: {
          type: "object",
          properties: {
            amenities: {
              type: "array",
              items: { type: "string" },
              description: "Array of amenity names to search for (e.g., ['WiFi', 'Air Conditioning', 'Pool']). Use getAllAmenities to see all available amenities."
            },
            matchType: {
              type: "string",
              enum: ["any", "all"],
              description: "OPTIONAL: 'any' (default) finds stays with at least one amenity, 'all' finds stays with all amenities"
            },
            minWifiSpeed: {
              type: "number",
              description: "OPTIONAL: Minimum WiFi download speed in Mbps (default: 0). Only returns stays with WiFi speed at or above this threshold."
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 25)"
            }
          },
          required: ["amenities"]
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStaysByWiFiSpeed",
        description: "Find all stays with WiFi download speed greater than 10Mbps, listed and not suspended.",
        inputSchema: {
          type: "object",
          properties: {
            minWiFiDownloadSpeed: {
              type: "number",
              description: "Minimum WiFi download speed in Mbps (default: 10)"
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 15)"
            }
          },
          required: []
        },
        _meta: stayResultsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getAllLifestyles",
        description: "Returns all active lifestyle/genre categories available in NomadStays. Use this to discover what lifestyle categories exist before searching with getStaysByLifestyle.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getAllAmenities",
        description: "List all possible amenities in the database, grouped into Stay Amenities (referenced by tbStaysFacilities) and Room Amenities (referenced by tbStaysRoom.RoomFacilityFk).",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "checkStayAvailability",
        description: "Check if a specific stay is available for given check-in and check-out dates. Returns availability status and room details.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: {
              type: "string",
              description: "The unique identifier of the stay"
            },
            checkIn: {
              type: "string",
              description: "Check-in date in ISO format (YYYY-MM-DD)"
            },
            checkOut: {
              type: "string",
              description: "Check-out date in ISO format (YYYY-MM-DD)"
            },
            roomType: {
              type: "string",
              description: "Optional specific room type to check availability for"
            }
          },
          required: ["stayId", "checkIn", "checkOut"]
        },
        _meta: availabilityWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "findNearestAvailability",
        description: "Find the nearest available dates when requested dates are not available. Searches for alternative check-in dates within a specified window and can adjust length of stay.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: {
              type: "string",
              description: "The unique identifier of the stay"
            },
            preferredCheckIn: {
              type: "string",
              description: "Preferred check-in date in ISO format (YYYY-MM-DD)"
            },
            minLengthOfStay: {
              type: "number",
              description: "Minimum length of stay in days"
            },
            maxLengthOfStay: {
              type: "number",
              description: "Maximum length of stay in days (optional)"
            },
            searchWindowDays: {
              type: "number",
              description: "Number of days before and after preferred date to search (default: 90)"
            }
          },
          required: ["stayId", "preferredCheckIn", "minLengthOfStay"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getAvailabilityByMonth",
        description: "Get all available booking windows in a specific month that meet the minimum length of stay requirement. Returns all possible check-in dates and their corresponding available periods.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: {
              type: "string",
              description: "The unique identifier of the stay"
            },
            year: {
              type: "number",
              description: "Year (e.g., 2026)"
            },
            month: {
              type: "number",
              description: "Month number (1-12, where 1=January, 12=December)"
            },
            minLengthOfStay: {
              type: "number",
              description: "Minimum length of stay in days required"
            }
          },
          required: ["stayId", "year", "month", "minLengthOfStay"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getRoomAvailability",
        description: "Check a specific room's availability for each night in a date range. Returns availability status (available/not available) for each night.",
        inputSchema: {
          type: "object",
          properties: {
            roomId: {
              type: "string",
              description: "The unique identifier of the room (tbStaysRoom.EntryID)"
            },
            checkIn: {
              type: "string",
              description: "Check-in date in ISO format (YYYY-MM-DD)"
            },
            checkOut: {
              type: "string",
              description: "Check-out date in ISO format (YYYY-MM-DD)"
            }
          },
          required: ["roomId", "checkIn", "checkOut"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getRoomAmenities",
        description: "Get comprehensive list of all facilities and amenities for a specific room, including WiFi metrics (download/upload speed, jitter). Returns room details, all facilities, and network performance data.",
        inputSchema: {
          type: "object",
          properties: {
            roomId: {
              type: "string",
              description: "The unique identifier of the room (tbStaysRoom.EntryID)"
            }
          },
          required: ["roomId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getMyStays",
        description: "List all Stays owned by the account bound to the MCP agent token. Returns stayId, title, and listed status for each — use this to find a stayId before calling any other owner-scoped tool. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        _meta: listCardsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayDetail",
        description: "Get the current title, description, and listed status for one of your Stays. Call this before updateStayDetail so the agent knows the current values and doesn't accidentally overwrite them. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayOnboardingStatus",
        description: "Get the Stay's listing-completion scores — the same six 'Listing Completion' cards shown on the Stay dashboard (Stay Details, Availability, Rooms, Packages, Wi-Fi, Operator Information), plus an overall completion percentage. Use this when a host asks how far along they are with onboarding or what's left to finish. Note: Wi-Fi is a test-freshness score (recency of the last speed test), not a speed rating, and Operator Information is a status label ('Open'), not a real percentage — both are noted via isPlaceholder/behavior in the response. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayRooms",
        description: "List all rooms currently configured on one of your Stays, including bed setup, occupancy, facilities (resolved to names, not just IDs), and every room/workspace photo as a viewable CDN URL. Call this before createStayRoom, updateStayRoom, deleteStayRoom, deleteRoomPhoto, or reorderRoomPhotos so the agent can show current values or find the right roomId/fileName. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayPackages",
        description: "List all pricing packages on one of your Stays, including their full price tiers (days, buy price, sell price, comparison price, listed status). Call this before createStayPackage or updateStayPackage — hosts often forget exactly what packages/pricing they've already set. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayOrganisationalData",
        description: "Get a Stay's organisational data: address, check-in/out policy, pets/children/parking, cancellation policy, tourism/land-registration numbers. Call this before updateStayOrganisationalData so the agent knows current values. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyBusinessProfile",
        description: "Get the host account's business profile: legal business name, VAT/business registration numbers, whether registered as a business entity. Does NOT include bank or tax-ID details — those are never exposed via MCP. Call this before updateHostBusinessProfile. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "updateStayDetail",
        description: "Update a Stay's title and/or description. Requires an MCP agent token (NOMADSTAYS_MCP_AGENT_TOKEN) scoped to the owning account. Only fields supplied are changed.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            title: { type: "string", description: "OPTIONAL: new title" },
            description: { type: "string", description: "OPTIONAL: new description" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "createStayRoom",
        description: "Create a new room on a Stay. Call getRoomTypeOptions(stayId) and getRoomFacilityOptions() first to find valid roomTypeFK/roomFacilityFk values. Boutique Stays are capped at 6 rooms total (one per Boutique1-6 slot) — creation is rejected once all 6 exist. Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            roomTitle: { type: "string", description: "Room name/title" },
            roomDescription: { type: "string", description: "OPTIONAL: room description" },
            roomTypeFK: { type: "number", description: "REQUIRED for non-boutique Stays — a roomTypeId from getRoomTypeOptions(stayId). IGNORED for boutique Stays — the next available Boutique1-6 slot is auto-assigned server-side, matching the host UI (which has no room-type picker for boutique room creation)." },
            beds: { type: "number", description: "OPTIONAL: number of beds" },
            maxPerson: { type: "number", description: "OPTIONAL: max occupancy" },
            mainBedSize: { type: "string", enum: ["Single", "Double", "Twin", "Queen", "King", "Other"], description: "OPTIONAL: main bed size" },
            otherBedSize: { type: "string", enum: ["Single", "Double", "Twin", "Queen", "King", "Other", ""], description: "OPTIONAL: other bed size, or empty for none" },
            roomFacilityFk: {
              type: "array",
              items: { type: "number" },
              description: "OPTIONAL: facilityDetailId values from getRoomFacilityOptions() — the full set of amenities this room has. Wi-Fi is added automatically even if omitted."
            },
            mcpRoomId: { type: "string", description: "OPTIONAL: external MCP room identifier to bind. NOT AVAILABLE for boutique Stays — the host UI has no field for this there, and the API will reject it." }
          },
          required: ["stayId", "roomTitle"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "updateStayRoom",
        description: "Update an existing room on a Stay. Only fields supplied are changed. Call getRoomTypeOptions(stayId) and getRoomFacilityOptions() first to find valid roomTypeFK/roomFacilityFk values. Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            roomId: { type: "number", description: "The room's EntryID (tbStaysRoom) — use getMyStayRooms to find it" },
            roomTitle: { type: "string" },
            roomDescription: { type: "string" },
            roomTypeFK: { type: "number", description: "A roomTypeId from getRoomTypeOptions(stayId)." },
            beds: { type: "number" },
            maxPerson: { type: "number" },
            mainBedSize: { type: "string", enum: ["Single", "Double", "Twin", "Queen", "King", "Other"] },
            otherBedSize: { type: "string", enum: ["Single", "Double", "Twin", "Queen", "King", "Other", ""] },
            roomFacilityFk: {
              type: "array",
              items: { type: "number" },
              description: "The FULL replacement list of facilityDetailId values from getRoomFacilityOptions() — anything not included will be removed (except Wi-Fi, which is always kept)."
            },
            mcpRoomId: { type: "string", description: "External MCP room identifier. NOT AVAILABLE for boutique Stays — the host UI has no field for this there, and the API will reject it." }
          },
          required: ["stayId", "roomId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "deleteStayRoom",
        description: "Delete (soft-delete) a room from a Stay. Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            roomId: { type: "number", description: "The room's EntryID — use getMyStayRooms to find it" }
          },
          required: ["stayId", "roomId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
      },
      {
        name: "getRoomTypeOptions",
        description: "List valid room types for a specific Stay's rooms (roomTypeFK in createStayRoom/updateStayRoom). Valid values depend on the Stay: boutique Stays choose from a fixed boutique type range; standard Stays are restricted to types already used on one of their own rooms. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getRoomFacilityOptions",
        description: "List every room-level amenity/facility option available (roomFacilityFk in createStayRoom/updateStayRoom) — e.g. Wi-Fi, Air Conditioning, Private Bathroom. Wi-Fi is mandatory and always included even if not explicitly selected. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: { type: "object", properties: {}, required: [] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "deleteRoomPhoto",
        description: "Delete one photo from a room's gallery. Call getMyStayRooms first to find the exact fileName. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            roomId: { type: "number", description: "The room's EntryID" },
            roomArea: { type: "string", enum: ["photos", "workspace"], description: "'photos' for the regular room gallery, 'workspace' for the room's coworking gallery" },
            fileName: { type: "string", description: "The exact file name from getMyStayRooms" }
          },
          required: ["stayId", "roomId", "roomArea", "fileName"]
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
      },
      {
        name: "reorderRoomPhotos",
        description: "Change the display order of a room's photo gallery. fileNames must be the FULL current gallery (same set, just reordered) — call getMyStayRooms first. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            roomId: { type: "number", description: "The room's EntryID" },
            roomArea: { type: "string", enum: ["photos", "workspace"], description: "'photos' for the regular room gallery, 'workspace' for the room's coworking gallery" },
            fileNames: {
              type: "array",
              items: { type: "string" },
              description: "The complete gallery file names in the new desired order — must match the current set exactly (call getMyStayRooms first)"
            }
          },
          required: ["stayId", "roomId", "roomArea", "fileNames"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "createStayPackage",
        description: "Create a new pricing package on a Stay, optionally with initial price tiers. Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            packageName: { type: "string", description: "Package name" },
            description: { type: "string", description: "OPTIONAL: package description" },
            roomTypeFK: { type: "number", description: "OPTIONAL: room type id this package covers. Call getRoomTypeOptions for valid values." },
            stayRoomFK: { type: "number", description: "STRONGLY RECOMMENDED: the specific room this package covers (tbStaysRoom.EntryID). Call getMyStayRooms to find the right room id first. If omitted, the server guesses a room matching roomTypeFK, which may pick the wrong one when a Stay has multiple rooms of the same type." },
            currencyFK: { type: "number", description: "OPTIONAL: currency id. Call getCurrencyOptions for valid values." },
            maxPax: { type: "number", description: "OPTIONAL: max occupancy for this package" },
            listed: { type: "boolean", description: "OPTIONAL: whether the package is publicly listed" },
            startDate: { type: "string", format: "date", description: "OPTIONAL: first check-in date this package is available for" },
            endDate: { type: "string", format: "date", description: "OPTIONAL: last check-in date this package is available for" },
            advertisingEndpoint: { type: "string", description: "OPTIONAL: only usable on Advertising-business-model Stays — ignored otherwise, matching the host UI which hides this field for all other business models. Check getBusinessModelOptions / the Stay's businessModelFK before setting." },
            prices: {
              type: "array",
              description: "OPTIONAL: initial price tiers. If supplied, replaces all price rows for the package. Exactly one entry per 7/14/21/30-night tier used.",
              items: {
                type: "object",
                properties: {
                  days: { type: "number", enum: [7, 14, 21, 30], description: "Length-of-stay tier in nights — must be one of 7, 14, 21, 30, the only tiers the host UI supports" },
                  buyPrice: { type: "number", description: "Internal cost basis. SellPrice is NOT settable — it is always server-computed from buyPrice (buyPrice / 0.88, or = buyPrice for Advertising-model Stays), matching the host UI exactly" },
                  listed: { type: "boolean", description: "Whether this price tier is publicly listed" }
                },
                required: ["days", "buyPrice", "listed"]
              }
            }
          },
          required: ["stayId", "packageName"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "updateStayPackage",
        description: "Update an existing pricing package on a Stay. Supplying 'prices' replaces ALL price rows for that package. Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            packageId: { type: "number", description: "The package's EntryID (tbStayPackages)" },
            packageName: { type: "string" },
            description: { type: "string" },
            roomTypeFK: { type: "number", description: "Call getRoomTypeOptions for valid values." },
            stayRoomFK: { type: "number", description: "The specific room this package covers (tbStaysRoom.EntryID). Call getMyStayRooms to find valid values." },
            currencyFK: { type: "number", description: "Call getCurrencyOptions for valid values." },
            maxPax: { type: "number" },
            listed: { type: "boolean" },
            isActive: { type: "boolean", description: "OPTIONAL: archive (false) or restore (true) this package — cascades to 'listed' on all its price tiers, matching the host UI's Archive/Restore actions" },
            startDate: { type: "string", format: "date", description: "OPTIONAL: first check-in date this package is available for" },
            endDate: { type: "string", format: "date", description: "OPTIONAL: last check-in date this package is available for" },
            advertisingEndpoint: { type: "string", description: "OPTIONAL: only usable on Advertising-business-model Stays — ignored otherwise, matching the host UI which hides this field for all other business models." },
            prices: {
              type: "array",
              description: "OPTIONAL: replaces ALL price rows for this package when supplied. Exactly one entry per 7/14/21/30-night tier used.",
              items: {
                type: "object",
                properties: {
                  days: { type: "number", enum: [7, 14, 21, 30], description: "Length-of-stay tier in nights — must be one of 7, 14, 21, 30" },
                  buyPrice: { type: "number", description: "Internal cost basis. SellPrice is NOT settable — always server-computed from buyPrice" },
                  listed: { type: "boolean" }
                },
                required: ["days", "buyPrice", "listed"]
              }
            }
          },
          required: ["stayId", "packageId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "deleteStayPackage",
        description: "Permanently delete a pricing package and all its price tiers from a Stay. This is a hard delete (unlike room deletion, which is soft). Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            packageId: { type: "number", description: "The package's EntryID (tbStayPackages) to delete" }
          },
          required: ["stayId", "packageId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
      },
      {
        name: "getCurrencyOptions",
        description: "List valid currency ids/codes for use as a package's currencyFK.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "updateStayOrganisationalData",
        description: "Update a Stay's organisational data: address, check-in/out policy, pets/children/parking, cancellation policy, accommodation type, tourism/land-registration numbers, 'Why Choose Us' reasons, and more. Only fields supplied are changed. IMPORTANT: countryId, petsAllowedId, childrenAllowedId, parkingId, cxPolicyId, and stayTypeId are lookup IDs, NOT plain text or booleans — call getCountryOptions / getAdditionalInformationOptions / getCancellationPolicyOptions / getStayTypeOptions first to find the correct ID to send. Requires an MCP agent token scoped to the owning account.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            address: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            postCode: { type: "string" },
            countryId: { type: "string", description: "A country ID from getCountryOptions — NOT a country name." },
            checkInFrom: { type: "string" },
            checkInTo: { type: "string" },
            checkOutFrom: { type: "string" },
            checkOutTo: { type: "string" },
            earlyCheckIn: { type: "boolean" },
            lateCheckout: { type: "boolean" },
            petsAllowedId: { type: "string", description: "An optionId from getAdditionalInformationOptions(filterName='Pets Allowed') — NOT a boolean." },
            childrenAllowedId: { type: "string", description: "An optionId from getAdditionalInformationOptions(filterName='Children Allowed') — NOT a boolean." },
            parkingId: { type: "string", description: "An optionId from getAdditionalInformationOptions(filterName='Parking') — NOT a boolean." },
            cxPolicyId: { type: "string", description: "A cxPolicyId from getCancellationPolicyOptions." },
            customCxPolicyLink: { type: "string" },
            tourismNumber: { type: "string" },
            landRegistrationNumber: { type: "string" },
            registeredBusiness: { type: "boolean", description: "Whether the Stay is officially registered for tourism/lodging" },
            stayTypeId: { type: "number", description: "A stayTypeId from getStayTypeOptions." },
            totalRooms: { type: "number" },
            checkinLocationWhat3Words: { type: "string", description: "what3words location for guest check-in" },
            reason1: { type: "string", description: "First 'Why Choose Us' reason shown to guests" },
            reason2: { type: "string" },
            reason3: { type: "string" },
            receiveReviews: { type: "boolean" },
            geoLat: { type: "number", description: "Map pin latitude" },
            geoLng: { type: "number", description: "Map pin longitude" },
            fullPayment: { type: "boolean", description: "Whether guests must pay in full up front (vs. pay on arrival). Only settable if the Stay's country allows it — check fullPaymentAllowedByCountry from getMyStayOrganisationalData first; writing true when the country doesn't allow it will be rejected." }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "updateHostBusinessProfile",
        description: "Update the host account's business profile (legal business name, VAT/business registration numbers). Applies to the account owning the MCP agent token, not a specific stay. Only fields supplied are changed. Does NOT touch bank or tax-ID details — those are not MCP-writable.",
        inputSchema: {
          type: "object",
          properties: {
            businessName: { type: "string" },
            vatNumber: { type: "string" },
            businessNumber: { type: "string" },
            entityAccount: { type: "boolean", description: "Whether the host operates as a registered business entity" }
          },
          required: []
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "uploadStayPhoto",
        description: "Upload a photo to one of your Stay's photo areas. Supply EXACTLY ONE of 'url' (a public https:// link, e.g. a Google Drive or Dropbox share link — the server downloads it) or 'base64' (the raw image bytes, base64-encoded — use this when you already have the image data in hand, e.g. a user attached a photo in the conversation, and have nowhere public to host it first). The photo is validated against the same minimum specs as a manual upload: JPEG, PNG, or WebP, under 20MB, and a minimum resolution that depends on area. Most areas require at least 1920x1080 landscape; 'host' requires at least 1080x1350 PORTRAIT — a landscape photo will be rejected for that area. Every upload is downscaled to fit within 2560x1440 and re-encoded server-side as WebP (stripping metadata and anything that isn't genuine image data) before storage. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" },
            area: {
              type: "string",
              enum: ["listing", "main", "workspace", "host", "room"],
              description:
                "Which photo area this belongs to:\n" +
                "- 'listing': general Stay gallery photos (multiple allowed, min 1920x1080 landscape)\n" +
                "- 'main': the single hero/cover photo shown first for the Stay (min 1920x1080 landscape, replaces any existing main photo)\n" +
                "- 'workspace': coworking/workspace photos for the whole Stay (multiple allowed, min 1920x1080 landscape)\n" +
                "- 'host': a photo of the HOST/CONTACT PERSON, not the property — must be PORTRAIT orientation, min 1080x1350 (replaces any existing host photo)\n" +
                "- 'room': photos for one specific room — requires roomId (multiple allowed, min 1920x1080 landscape)"
            },
            url: { type: "string", description: "A public https:// URL the server can download the image from (e.g. a Google Drive or Dropbox share link). Supply this OR base64, not both." },
            base64: { type: "string", description: "Base64-encoded JPEG, PNG, or WebP image bytes (a data:image/...;base64,... URI prefix is also accepted and stripped automatically). Supply this OR url, not both. Under ~27MB encoded (20MB image)." },
            roomId: { type: "number", description: "Required when area is 'room' — the room's EntryID (use getMyStayRooms to find it). Ignored for other areas." }
          },
          required: ["stayId", "area"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getMyStayContacts",
        description: "Get a Stay's contact/owner/manager details and social media links: owner name/email/mobile, manager (day-to-day contact person) name/email/mobile, booking email/phone/mobile, host display name, and website/Facebook/Twitter/YouTube/Instagram/TikTok/LinkedIn links. Call this before updateStayContacts so the agent knows current values. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "updateStayContacts",
        description: "Update a Stay's contact/owner/manager details and social media links. Only fields supplied are changed. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            ownerName: { type: "string" },
            ownerEmail: { type: "string" },
            ownerMobile: { type: "string" },
            managerName: { type: "string", description: "The day-to-day contact person's name (not necessarily the owner)" },
            managerEmail: { type: "string" },
            managerMobile: { type: "string" },
            bookingEmail: { type: "string", description: "Email guests use to reach the Stay about bookings" },
            bookingPhone: { type: "string" },
            bookingMobile: { type: "string" },
            hostFullName: { type: "string", description: "Display name shown to guests as the host" },
            website: { type: "string" },
            facebookPage: { type: "string" },
            twitter: { type: "string", description: "X (Twitter) profile link" },
            youtube: { type: "string" },
            instagram: { type: "string" },
            tikTok: { type: "string" },
            linkedIn: { type: "string" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayFacilities",
        description: "Get the available options AND current selections for one facility/checkbox group on a Stay — e.g. 'Languages Spoken' returns every language the platform supports plus which ones are currently selected for this Stay. Call getFacilityGroups first if you don't know the exact group name. Common groups: 'General', 'Services', 'Languages Spoken', 'Meal', 'Position', 'Remote Worker'. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            group: { type: "string", description: "Exact facility group name, e.g. 'Languages Spoken', 'General', 'Services', 'Meal', 'Position', 'Remote Worker' (call getFacilityGroups for the full list)" }
          },
          required: ["stayId", "group"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "updateStayFacilities",
        description: "Set which options are selected for one facility/checkbox group on a Stay — e.g. which languages are spoken. facilityDetailIds is the COMPLETE replacement list: anything not included will be UNCHECKED. Call getMyStayFacilities first to see current selections and valid IDs before changing them. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            group: { type: "string", description: "Exact facility group name, matching what getMyStayFacilities was called with" },
            facilityDetailIds: {
              type: "array",
              items: { type: "number" },
              description: "The FULL list of facilityDetailId values that should be selected after this call — call getMyStayFacilities first to see valid IDs. An empty array clears all selections in this group."
            }
          },
          required: ["stayId", "group", "facilityDetailIds"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getFacilityGroups",
        description: "List every facility/checkbox group name that exists on the platform (e.g. 'Languages Spoken', 'General', 'Services', 'Meal', 'Position', 'Remote Worker'). Call this first if you don't already know the exact group name to pass to getMyStayFacilities/updateStayFacilities. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: { type: "object", properties: {}, required: [] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStayTypeOptions",
        description: "List valid values for a Stay's 'Main Accommodation Type' (stayTypeId in updateStayOrganisationalData). Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: { type: "object", properties: {}, required: [] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getCountryOptions",
        description: "List valid values for a Stay's country (countryId in updateStayOrganisationalData), with each country's name and 2-letter code. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: { type: "object", properties: {}, required: [] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getCancellationPolicyOptions",
        description: "List valid values for a Stay's cancellation policy (cxPolicyId in updateStayOrganisationalData). Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: { type: "object", properties: {}, required: [] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getAdditionalInformationOptions",
        description: "List valid values for one of the Additional Information picklists used in updateStayOrganisationalData: Children Allowed, Pets Allowed, or Parking. These are NOT booleans — they're lookup IDs (e.g. 'Yes', 'No', 'On Request') — call this to find the right value before writing petsAllowedId/childrenAllowedId/parkingId. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            filterName: { type: "string", enum: ["Children Allowed", "Pets Allowed", "Parking"], description: "Which picklist to fetch options for" }
          },
          required: ["filterName"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getBusinessModelOptions",
        description: "List valid values for a Stay's listing/business model (businessModelId, read-only — displayed on the Stay but not editable via MCP or the host UI itself). Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: { type: "object", properties: {}, required: [] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getMyStayPhotos",
        description: "Get every current photo for a Stay across all areas (listing gallery, main/hero, workspace/coworking gallery, host), each as a full https:// CDN URL an agent can view directly (not just a filename). Call this before deleteStayPhoto or reorderStayPhotos to see current filenames. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID (use getMyStays to find it)" }
          },
          required: ["stayId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "deleteStayPhoto",
        description: "Delete one photo from a Stay. Call getMyStayPhotos first to find the exact fileName. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            area: { type: "string", enum: ["listing", "main", "workspace", "host"], description: "Which photo area the file belongs to (room photos aren't supported by this tool — manage those via updateStayRoom)" },
            fileName: { type: "string", description: "The exact file name from getMyStayPhotos, e.g. '69bdf22cdb0c43a7be3e825a0a3a2074.jpg'" }
          },
          required: ["stayId", "area", "fileName"]
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
      },
      {
        name: "reorderStayPhotos",
        description: "Change the display order of a Stay's listing or workspace photo gallery. fileNames must be the FULL current gallery (same set of files, just reordered) — call getMyStayPhotos first. This only reorders; it cannot add or remove photos. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            stayId: { type: "number", description: "The Stay's EntryID" },
            area: { type: "string", enum: ["listing", "workspace"], description: "Only these two areas support reordering" },
            fileNames: {
              type: "array",
              items: { type: "string" },
              description: "The complete gallery file names in the new desired order — must match the current set exactly (call getMyStayPhotos first)"
            }
          },
          required: ["stayId", "area", "fileNames"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "getProductInfo",
        description: "Look up a Nomad Stays product's price and purchasability — currently only product 8, the Stay Application fee (EUR 39). Returns isWaivedForCaller: true if the caller is already a Stay Partner re-applying, in which case there's nothing to pay and purchaseProduct will process the waiver automatically. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            productId: { type: "number", description: "The product's EntryID — use 8 for the Stay Application fee" }
          },
          required: ["productId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "purchaseProduct",
        description: "Start a purchase of a Nomad Stays product on the caller's own behalf. If the caller already qualifies for a waiver (e.g. an existing Stay Partner re-applying), this resolves immediately with no payment step and returns status 'waived'. Otherwise it returns a checkoutUrl hosted on nomadstays.com — you must hand this URL to the member and ask them to open it in their own browser and pay; you cannot complete payment on their behalf. Poll getPurchaseStatus with the returned saleId afterwards to find out when it's actually paid. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            productId: { type: "number", description: "The product's EntryID — use 8 for the Stay Application fee" },
            applicationId: { type: "number", description: "Optional: if this purchase is paying a Stay Application's fee, pass its applicationId (from createStayApplication) so the payment is applied back to that application automatically once paid" }
          },
          required: ["productId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getPurchaseStatus",
        description: "Check whether a purchase has been paid. Only ever reports 'paid' after a fresh server-side check against the payment provider — never trust the member's own claim that they've paid, always poll this instead. Possible statuses: pending, paid, failed, waived. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            saleId: { type: "string", description: "The saleId returned by purchaseProduct" }
          },
          required: ["saleId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "listStayApplications",
        description: "List the caller's Stay Applications (draft and submitted), each with a nextAction hint telling you what's needed next (provide_applicant_details, provide_property_details, pay_application_fee, submit, awaiting_review, or accepted). Call this to find an in-progress application's applicationId before resuming it. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        _meta: listCardsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getStayApplication",
        description: "Get the full current state of one Stay Application, including a nextAction hint and (if incomplete) a missingFields list naming exactly which required fields are still empty. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID (use listStayApplications to find it)" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "createStayApplication",
        description: "Start a new Stay Application for the caller. Any fields can be supplied now or filled in later via saveStayApplication — the applicant's name defaults from their Nomad Stays profile if not supplied. Call getCountries and getBusinessModels first to resolve stayCountryId/postalCountryId/businessModelId, since country-specific rules (VAT number, tourism number, permitted business models) are enforced server-side and rejections name the specific field/reason. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicantFirstName: { type: "string", description: "Overrides the profile default for this application only — does not change the member's profile" },
            applicantLastName: { type: "string", description: "Overrides the profile default for this application only — does not change the member's profile" },
            applicantEmail: { type: "string" },
            mobile: { type: "string" },
            businessName: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            postalCountryId: { type: "number", description: "tbCountry.CountryId for the applicant's billing/postal address — used only to check whether a VAT number is required, and stored on the member's business profile (not on the application itself). Use getCountries to find a value." },
            vatNumber: { type: "string", description: "Required if the postal country's vatNumberRequired flag is true (see getCountries)" },
            stayName: { type: "string" },
            stayCountryId: { type: "number", description: "tbCountry.CountryId for where the Stay is actually located — this is the country the application itself is filed under. Use getCountries to find a value." },
            tourismNumber: { type: "string", description: "Required if the stay country's tourismNumberRequired flag is true (see getCountries)" },
            businessModelId: { type: "number", description: "tbBusinessModel.EntryID — use getBusinessModels. If the stay country's bookingModelsRestricted flag is true, only a 'StayDirect'-prefixed model is accepted." },
            monthlyPrice: { type: "string" },
            availabilitySupplier: { type: "string" },
            hasKitchen: { type: "boolean" },
            laundryFacilities: { type: "string", enum: ["No", "On Premises", "Nearby"] },
            workFacilities: { type: "string", enum: ["None", "Both", "In Room", "CoWorking Space"] },
            downloadSpeed: { type: "string" },
            numberOfRooms: { type: "string" },
            website: { type: "string" },
            comments: { type: "string" }
          },
          required: []
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "saveStayApplication",
        description: "Update any subset of fields on an existing, not-yet-submitted Stay Application. Same field set and validation rules as createStayApplication — only pass the fields you're changing. Fails with a 409 if the application has already been submitted. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID" },
            applicantFirstName: { type: "string" },
            applicantLastName: { type: "string" },
            applicantEmail: { type: "string" },
            mobile: { type: "string" },
            businessName: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            postalCountryId: { type: "number", description: "tbCountry.CountryId — used only for the VAT check, stored on the business profile, not on the application. Use getCountries." },
            vatNumber: { type: "string" },
            stayName: { type: "string" },
            stayCountryId: { type: "number", description: "tbCountry.CountryId — the country the application itself is filed under. Use getCountries." },
            tourismNumber: { type: "string" },
            businessModelId: { type: "number", description: "tbBusinessModel.EntryID — use getBusinessModels." },
            monthlyPrice: { type: "string" },
            availabilitySupplier: { type: "string" },
            hasKitchen: { type: "boolean" },
            laundryFacilities: { type: "string", enum: ["No", "On Premises", "Nearby"] },
            workFacilities: { type: "string", enum: ["None", "Both", "In Room", "CoWorking Space"] },
            downloadSpeed: { type: "string" },
            numberOfRooms: { type: "string" },
            website: { type: "string" },
            comments: { type: "string" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "submitStayApplication",
        description: "Submit a completed Stay Application for human review. Rejects with a missingFields list if any required field is still empty, or a 409 if the Application Fee hasn't been paid/waived yet (call purchaseProduct with productId 8 and applicationId first). There is no partial/optimistic submission — everything required must already be in place. On success the application moves to human review; nothing further is needed from the agent. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "listExperienceApplications",
        description: "List the caller's Experience Applications (draft and submitted), each with a nextAction hint telling you what's needed next (provide_applicant_details, provide_experience_details, pay_application_fee, submit, awaiting_review, or accepted). Call this to find an in-progress application's applicationId before resuming it. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        _meta: listCardsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getExperienceApplication",
        description: "Get the full current state of one Experience Application, including a nextAction hint and (if incomplete) a missingFields list naming exactly which required fields are still empty. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID (use listExperienceApplications to find it)" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "createExperienceApplication",
        description: "Start a new Experience Application for the caller. Any fields can be supplied now or filled in later via saveExperienceApplication — the applicant's name defaults from their Nomad Stays profile if not supplied. Call getCountries and getBusinessModels first to resolve experienceCountryId/postalCountryId/businessModelId, since country-specific rules (VAT number, tourism number, permitted business models) are enforced server-side and rejections name the specific field/reason. Experiences must run a minimum of 4 days. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicantFirstName: { type: "string", description: "Overrides the profile default for this application only — does not change the member's profile" },
            applicantLastName: { type: "string", description: "Overrides the profile default for this application only — does not change the member's profile" },
            applicantEmail: { type: "string" },
            mobile: { type: "string" },
            businessName: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            postalCountryId: { type: "number", description: "tbCountry.CountryId for the applicant's billing/postal address — used only to check whether a VAT number is required, and stored on the member's business profile (not on the application itself). Use getCountries to find a value." },
            vatNumber: { type: "string", description: "Required if the postal country's vatNumberRequired flag is true (see getCountries)" },
            experienceName: { type: "string" },
            experienceCountryId: { type: "number", description: "tbCountry.CountryId for where the experience actually takes place — this is the country the application itself is filed under. Use getCountries to find a value." },
            tourismNumber: { type: "string", description: "Required if the experience country's tourismNumberRequired flag is true (see getCountries)" },
            businessModelId: { type: "number", description: "tbBusinessModel.EntryID — use getBusinessModels. If the experience country's bookingModelsRestricted flag is true, only a 'StayDirect'-prefixed model is accepted." },
            monthlyPrice: { type: "string", description: "Price per person (USD)" },
            hasInsurance: { type: "boolean" },
            availabilitySupplier: { type: "string" },
            hasKitchen: { type: "boolean" },
            laundryFacilities: { type: "string", enum: ["No", "On Premises", "Nearby"] },
            workFacilities: { type: "string", enum: ["None", "Both", "In Room", "CoWorking Space"] },
            downloadSpeed: { type: "string" },
            description: { type: "string" },
            daysQty: { type: "string", description: "Minimum 4 days, enforced server-side" },
            maxPax: { type: "string", description: "Maximum participants" },
            overnightLocationsQty: { type: "string" },
            website: { type: "string" },
            comments: { type: "string" }
          },
          required: []
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "saveExperienceApplication",
        description: "Update any subset of fields on an existing, not-yet-submitted Experience Application. Same field set and validation rules as createExperienceApplication — only pass the fields you're changing. Fails with a 409 if the application has already been submitted. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID" },
            applicantFirstName: { type: "string" },
            applicantLastName: { type: "string" },
            applicantEmail: { type: "string" },
            mobile: { type: "string" },
            businessName: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            postalCountryId: { type: "number", description: "tbCountry.CountryId — used only for the VAT check, stored on the business profile, not on the application. Use getCountries." },
            vatNumber: { type: "string" },
            experienceName: { type: "string" },
            experienceCountryId: { type: "number", description: "tbCountry.CountryId — the country the application itself is filed under. Use getCountries." },
            tourismNumber: { type: "string" },
            businessModelId: { type: "number", description: "tbBusinessModel.EntryID — use getBusinessModels." },
            monthlyPrice: { type: "string" },
            hasInsurance: { type: "boolean" },
            availabilitySupplier: { type: "string" },
            hasKitchen: { type: "boolean" },
            laundryFacilities: { type: "string", enum: ["No", "On Premises", "Nearby"] },
            workFacilities: { type: "string", enum: ["None", "Both", "In Room", "CoWorking Space"] },
            downloadSpeed: { type: "string" },
            description: { type: "string" },
            daysQty: { type: "string", description: "Minimum 4 days, enforced server-side" },
            maxPax: { type: "string" },
            overnightLocationsQty: { type: "string" },
            website: { type: "string" },
            comments: { type: "string" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "submitExperienceApplication",
        description: "Submit a completed Experience Application for human review. Rejects with a missingFields list if any required field is still empty, or a 409 if the Application Fee hasn't been paid/waived yet (call purchaseProduct with productId 9 and applicationId first — Experience uses product 9, NOT product 8). There is no partial/optimistic submission. On success the application moves to human review. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "quoteStayBooking",
        description: "Get a server-computed price and availability quote for booking a Stay package on the caller's own behalf. Price is always re-derived from the package's actual pricing tiers — never trust or reuse a price shown elsewhere. Picks the largest price tier whose length is <= the requested nights (e.g. 10 nights against 7/14/21/30-day tiers uses the 7-day tier's rate), falling back to the smallest tier if the stay is shorter than all of them. Returns a quoteId valid for about 15 minutes — call bookStay with it to actually create the booking and get a payment link. Requires the caller's token to carry the 'bookings' OAuth scope (McpMember role), separate from the listings-management 'McpAgent' scope other tools here use.",
        inputSchema: {
          type: "object",
          properties: {
            packageId: { type: "number", description: "The Stay package's ID (from getPackages or search/browse tools)" },
            checkIn: { type: "string", description: "Check-in date, YYYY-MM-DD" },
            checkOut: { type: "string", description: "Check-out date, YYYY-MM-DD" },
            rooms: { type: "number", description: "Number of rooms to book. Defaults to 1." },
            adults: { type: "number", description: "Number of adult guests. Defaults to 1." },
            children: { type: "number", description: "Number of child guests. Defaults to 0." },
            pets: { type: "number", description: "Number of pets. Defaults to 0." }
          },
          required: ["packageId", "checkIn", "checkOut"]
        },
        _meta: bookingWidgetMeta,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "bookStay",
        description: "Create a real booking from a quoteId returned by quoteStayBooking, and return a hosted checkoutUrl. The quote's price/availability is re-validated server-side one more time before the booking is created — a stale or expired quote will be rejected with a message to call quoteStayBooking again. You MUST send the checkoutUrl to the member and tell them to open it in their own browser to pay — you cannot complete this payment on their behalf, and no card details ever pass through you. Requires NOMADSTAYS_MCP_AGENT_TOKEN with the 'bookings' scope.",
        inputSchema: {
          type: "object",
          properties: {
            quoteId: { type: "string", description: "The quoteId returned by quoteStayBooking" },
            contactName: { type: "string", description: "Guest's full name for the booking. Defaults to the member's account name if omitted." },
            contactEmail: { type: "string", description: "Contact email for the booking. Defaults to the member's account email if omitted." },
            contactPhone: { type: "string", description: "Contact phone number for the booking." },
            specialRequest: { type: "string", description: "Any special request to pass along to the Stay." }
          },
          required: ["quoteId"]
        },
        _meta: bookingWidgetMeta,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getBookingStatus",
        description: "Check a Stay booking's real payment status by PNR. Status is always freshly re-verified against Airwallex directly if not already confirmed paid — never trust a client-supplied claim of success. Only ever returns bookings owned by the caller's own account. Requires NOMADSTAYS_MCP_AGENT_TOKEN with the 'bookings' scope.",
        inputSchema: {
          type: "object",
          properties: {
            pnr: { type: "string", description: "The booking reference (PNR) returned by bookStay" }
          },
          required: ["pnr"]
        },
        _meta: bookingWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "listMyBookings",
        description: "List all Stay bookings owned by the caller's own account, most recent first, with each one's current status. Each booking includes needsAction: true if it's still unpaid, with a ready-to-use checkoutUrl — call this proactively (e.g. at the start of a session, or when the member asks what's pending) and surface any needsAction bookings to the member, since there is no other way for them to be notified of an incomplete booking through this connection. Requires NOMADSTAYS_MCP_AGENT_TOKEN with the 'bookings' scope.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        _meta: listCardsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },

      {
        name: "listCoworkingApplications",
        description: "List the caller's Coworking Applications (draft and submitted), each with a nextAction hint (provide_coworking_details, submit, awaiting_review, or accepted). Coworking has no Application Fee, so unlike Stay/Experience there is no pay_application_fee step. Call this to find an in-progress application's applicationId before resuming it. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        _meta: listCardsWidgetMeta,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "getCoworkingApplication",
        description: "Get the full current state of one Coworking Application, including a nextAction hint and (if incomplete) a missingFields list naming exactly which required fields are still empty. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID (use listCoworkingApplications to find it)" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "createCoworkingApplication",
        description: "Start a new Coworking Application for the caller. Much simpler than the Stay/Experience applications: no VAT/tourism-number/business-model rules, no Application Fee, and no billing step at all — once coworkingName, applicantName, applicantEmail, city and country are present, nextAction goes straight to 'submit'. Call getCountries first to find a valid country name (must be the exact tbCountry.CountryName, not an ID). Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            coworkingName: { type: "string" },
            applicantName: { type: "string" },
            applicantEmail: { type: "string" },
            telephone: { type: "string" },
            address: { type: "string" },
            city: { type: "string" },
            country: { type: "string", description: "Exact tbCountry.CountryName (not a country ID) — use getCountries and take the countryName field. Must not be a sanctioned country." },
            website: { type: "string" }
          },
          required: []
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "saveCoworkingApplication",
        description: "Update any subset of fields on an existing, not-yet-submitted Coworking Application. Same field set and validation rules as createCoworkingApplication — only pass the fields you're changing. Fails with a 409 if the application has already been submitted. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID" },
            coworkingName: { type: "string" },
            applicantName: { type: "string" },
            applicantEmail: { type: "string" },
            telephone: { type: "string" },
            address: { type: "string" },
            city: { type: "string" },
            country: { type: "string", description: "Exact tbCountry.CountryName (not a country ID) — use getCountries." },
            website: { type: "string" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "submitCoworkingApplication",
        description: "Submit a completed Coworking Application for human review. Rejects with a missingFields list if any required field is still empty. There is no Application Fee to pay for Coworking, so — unlike submitStayApplication/submitExperienceApplication — this never returns a pay_application_fee/409-unpaid response. On success the application moves to human review. Requires NOMADSTAYS_MCP_AGENT_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            applicationId: { type: "number", description: "The application's ID" }
          },
          required: ["applicationId"]
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      }
    ]
  };
  });

  return server;
}

// Single shared instance for stdio mode (main()'s non-HTTP branch) and the module-level
// default export, both of which are genuinely single-connection for the process's lifetime —
// only the HTTP /mcp handler needs a fresh instance per request (createServer() called there).
const server = createServer();



/**
 * Start the server using stdio transport for local development
 * or HTTP transport for remote access (Coolify container).
 */
async function main() {
    const port = process.env.PORT || process.env.HTTP_PORT;

    if (port) {
      // HTTP mode for the Coolify-hosted container - provides REST API endpoints only
      const app = express();
      // Trust exactly one hop (Coolify's reverse proxy) so req.ip resolves to the real client
      // IP from X-Forwarded-For. `true` (trust every hop) previously let a caller spoof its own
      // X-Forwarded-For and forge whatever IP it wanted — express-rate-limit refuses to start
      // with that setting for exactly this reason (ERR_ERL_PERMISSIVE_TRUST_PROXY), since a
      // spoofed IP defeats the per-IP throttles below entirely.
      app.set('trust proxy', 1);
        
        // JSON body parser middleware
        // 27mb accommodates uploadStayPhoto's base64 payloads: a 20MB image (the app's own
        // max) becomes ~27MB once base64-encoded, plus JSON/field overhead.
        app.use(express.json({ limit: '27mb' }));
        
        // Initialize request logger for tracking AI Agent visits
        const connectionString = process.env.NOMADSTAYS_DB_CONNECTION || '';
        const requestLogger = new MCPRequestLogger(connectionString);
        
        // Add tracking middleware BEFORE routes
        app.use(createTrackingMiddleware(requestLogger));
        
        // CORS middleware - apply to all responses
        //
        // Only allowlisted browser origins get Access-Control-Allow-Origin at all — there used
        // to be an `else` branch sending `*` to every other origin (commented "Allow all origins
        // for API testing"), which undermined the allowlist above it and was also spec-invalid
        // in combination with Access-Control-Allow-Credentials: true below (browsers refuse a
        // credentialed response when the origin echoed back is a literal `*`, so it silently
        // didn't even work for its stated purpose). Non-browser MCP clients (Claude.ai, ChatGPT,
        // curl, server-to-server calls) don't enforce CORS at all, so removing the wildcard only
        // closes off malicious browser-based cross-origin use of a signed-in user's cookies —
        // it doesn't block any legitimate agent traffic, which was never CORS-gated to begin with.
        app.use((req, res, next) => {
            const allowedOrigins = [
                'https://mcp.nomadstays.com',
                'https://dev-mcp.nomadstays.com',
		'https://staging-mcp.nomadstays.com',
                'http://localhost:3000',
                'http://localhost:6274'
            ];
            const origin = req.headers.origin;
            if (origin && allowedOrigins.includes(origin)) {
                res.header('Access-Control-Allow-Origin', origin);
                res.header('Access-Control-Allow-Credentials', 'true');
            }
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version');
            res.header('Cache-Control', 'no-cache');
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
                return;
            }
            next();
        });
        
        // RFC 9728 protected resource metadata — tells MCP clients (Claude.ai, ChatGPT) which
        // authorization server issues tokens for this resource server, so they can run the
        // OAuth flow themselves when a protected tool call gets a 401. Served unconditionally,
        // not just as a fallback to the WWW-Authenticate header, since the MCP spec (2025-11-25)
        // requires clients to support proactive well-known-URI discovery too.
        const protectedResourceMetadata = {
            resource: RESOURCE_URI,
            authorization_servers: ["https://nomadstays.com"],
        };
        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            res.json(protectedResourceMetadata);
        });
        app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
            res.json(protectedResourceMetadata);
        });

        // OpenAI ChatGPT Apps SDK submission portal domain-verification challenge.
        // The portal generates a token when you enter this domain during "With MCP"
        // submission and expects it served back as plain text (not JSON/HTML) at this
        // exact path. Set OPENAI_APPS_CHALLENGE_TOKEN in Coolify once the portal shows
        // it — no redeploy needed for a token rotation, just update the env var.
        app.get('/.well-known/openai-apps-challenge', (req, res) => {
            const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
            if (!token) {
                res.status(404).send('Not found');
                return;
            }
            res.type('text/plain').send(token);
        });

        // Health check endpoint
        app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                service: 'nomadstays-mcp-server',
                timestamp: new Date().toISOString(),
                version: '0.7.0',
                transport: 'streamable-http',
                endpoints: {
                    mcp: '/mcp',
                    health: '/health'
                }
            });
        });

        // Initialize and add stats endpoints for tracking analytics
        const statsEndpoints = createStatsEndpoints(requestLogger);
        app.get('/api/mcp/stats/daily', statsEndpoints.getDailyStats);
        app.get('/api/mcp/stats/tools', statsEndpoints.getToolStats);
        app.get('/api/mcp/stats/detailed', statsEndpoints.getDetailedStats);

        // MCP Streamable HTTP endpoint - the modern transport, backed by the SDK's own
        // StreamableHTTPServerTransport rather than a hand-rolled JSON-RPC switch, so every
        // tool registered via server.setRequestHandler (ListToolsRequestSchema /
        // CallToolRequestSchema) is automatically dispatched here with no duplication.
        //
        // Stateless mode (sessionIdGenerator: undefined) requires a FRESH transport per
        // request — reusing one instance across requests causes message ID collisions
        // between callers, since there is no session to correlate them by.
        app.post('/mcp', mcpEndpointLimiter, async (req, res) => {
            try {
                const authHeader = req.headers['authorization'];
                const bearerMatch = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
                const callerToken = bearerMatch ? bearerMatch[1].trim() : undefined;

                // "Lazy authentication" (MCP's documented pattern for servers mixing public and
                // owner-scoped tools on one endpoint): initialize/tools/list and PUBLIC tool
                // calls always succeed with no credentials. Only when this specific request is a
                // tools/call targeting a PROTECTED tool do we gate on the token — and if it's
                // missing or fails validation, respond with a transport-level 401 +
                // WWW-Authenticate, not a silent JSON-RPC tool error. That distinction matters:
                // MCP clients (Claude.ai, ChatGPT) only auto-trigger their OAuth "Connect" UI on
                // a real 401, never on a 200 with isError:true — an ordinary thrown Error from
                // deep in a tool handler (as this server used to rely on) is invisible to them.
                if (requestCallsProtectedTool(req.body) && !(await isTokenAcceptable(callerToken))) {
                    res.status(401)
                        .set('WWW-Authenticate', `Bearer resource_metadata="https://mcp.nomadstays.com/.well-known/oauth-protected-resource"`)
                        .json({
                            jsonrpc: '2.0',
                            error: { code: -32001, message: 'Authentication required for this tool.' },
                            id: req.body?.id ?? null,
                        });
                    return;
                }

                // signupNomadStaysAccount is unauthenticated by design (no token can exist yet —
                // that's the entire reason the tool exists), so the mcpEndpointLimiter above is
                // its only other defense against being hammered for account-creation spam. Applies
                // the same tighter per-IP window Program.cs's "agent-signup" ASP.NET policy already
                // uses for this exact flow on the main web app.
                if (requestCallsSignup(req.body)) {
                    const clientIp = req.ip || (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
                    if (isSignupRateLimited(clientIp)) {
                        res.status(429).json({
                            jsonrpc: '2.0',
                            error: { code: -32029, message: 'Too many signup attempts. Please try again in a few minutes.' },
                            id: req.body?.id ?? null,
                        });
                        return;
                    }
                }

                // Fresh Server per request — see createServer()'s doc comment for why sharing
                // one instance across concurrent requests crashes with "Already connected to a
                // transport."
                const requestServer = createServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                });
                res.on('close', () => transport.close());
                await requestServer.connect(transport);
                await runWithRequestAgentToken(callerToken, () => transport.handleRequest(req, res, req.body));
            } catch (err: any) {
                console.error('StreamableHTTP request failed:', err?.stack ?? String(err));
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: 'Internal error', data: err?.message ?? String(err) },
                        id: req.body?.id ?? null
                    });
                }
            }
        });
        
        
        // Root endpoint - serve index.html
        app.get('/', (req, res) => {
            res.sendFile('index.html', { root: '.' });
        });
        
        app.listen(Number(port), () => {
            console.error(`MCP server listening on port ${port}`);
            console.error(`Health check: http://localhost:${port}/health`);
            console.error(`MCP endpoint: http://localhost:${port}/mcp`);
        });
    } else {
        // Stdio mode for standard MCP protocol
        const transport = new StdioServerTransport();
        await server.connect(transport);
        // Don't log anything in stdio mode - it interferes with JSON-RPC protocol
    }
}

// Only run main() if this file is executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
    main().catch((error) => {
        console.error("Server error:", error);
        process.exit(1);
    });
}

export default server;

