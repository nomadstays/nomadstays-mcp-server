#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Detect if we're running in HTTP mode (Azure App Service) or stdio mode (MCP Inspector/Client)
const isHttpMode = !!(process.env.PORT || process.env.HTTP_PORT);

// Load environment from .env file manually to avoid dotenv's stdout pollution in stdio mode
// This is critical because any stdout output breaks the JSON-RPC protocol over stdio
try {
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
  // Silently fail if .env doesn't exist - only log in HTTP mode
  if (isHttpMode && err?.code !== 'ENOENT') {
    console.warn('Failed to load .env file:', err?.message);
  }
}

// Global error handlers for better visibility in App Service logs
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
 * Create an MCP server with capabilities for resources (to list/read stays)
 * and tools (to query stays).
 * 
 * Fully compatible with both Claude and ChatGPT/OpenAI models
 */
const server = new Server(
  {
    name: "nomadstays-mcp25-dev",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    },
  }
);

import sql from "mssql";
import type { Stay } from "./types/stay.js";

// Register the "getStaysByCountry" and "getStaysByContinent" tools using setRequestHandler for CallToolRequestSchema
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "getStaysByWiFiSpeed") {
      const minWiFiDownloadSpeed = Number(request.params.arguments?.minWiFiDownloadSpeed) || 10;
      const limit = Number(request.params.arguments?.limit) || 15;
      const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
      let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
      connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
      if (!connStr) {
        throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
      }
      try {
        const { getStaysByWiFiSpeed } = await import('./db/getStaysByWiFiSpeed.js');
        const stays = await getStaysByWiFiSpeed(connStr, { minWiFiDownloadSpeed, limit });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(stays)
          }]
        };
      } catch (err: any) {
        throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
      throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set to query Azure SQL");
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
        }]
      };
    } catch (err: any) {
      throw new Error(`DB query failed: ${err?.message ?? String(err)}`);
    }
  }

  throw new Error("Unknown tool");
});

/**
 * Handler for listing available stays as resources.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Try to include stays from DB if a connection is configured
  const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
  let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
  // strip surrounding quotes and fix common port syntax mistakes
  connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
  if (!connStr) {
    return { resources: [] };
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

    return { resources: stayResources };
  } catch (err: any) {
    // If DB query fails, return empty array (don't hard-fail listing)
    console.error('Failed to list stays for resources:', err?.message ?? String(err));
    return { resources: [] };
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
        }
      },

      {
        name: "getStaysByCountry",
        description: "Returns stays from NomadStays Azure backend. Search by 2-letter country code (e.g., 'MA', 'US') or country name (e.g., 'Antigua' matches 'Antigua and Barbuda')",
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
        }
      },
      {
        name: "getStaysByContinent",
        description: "Returns stays from NomadStays Azure backend filtered by continent. Search by continent name (e.g., 'Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania')",
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
        }
      },
      {
        name: "getStaysByLocation",
        description: "Returns stays from NomadStays Azure backend that match a location search term. Searches across City, State, location_name, location_country, and location_description fields. Use this for flexible location searches (e.g., 'Paris', 'California', 'Beach', 'Mountain')",
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
        }
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
        }
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
        }
      },
      {
        name: "listHelpCenterCategories",
        description: "List all available NomadStays Help Center categories. Returns category ID, name, slug, description, and article count for each category.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "getStaysByLifestyle",
        description: "Returns stays from NomadStays Azure backend filtered by lifestyle/genre category (e.g., 'Digital Nomad', 'Beach Life', 'City Living', 'Mountain Retreat'). Each stay can belong to multiple lifestyle categories.",
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
        }
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
        }
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
        }
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
        }
      },

      {
        name: "getAllLifestyles",
        description: "Returns all active lifestyle/genre categories available in NomadStays. Use this to discover what lifestyle categories exist before searching with getStaysByLifestyle.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },

      {
        name: "getAllAmenities",
        description: "List all possible amenities in the database, grouped into Stay Amenities (referenced by tbStaysFacilities) and Room Amenities (referenced by tbStaysRoom.RoomFacilityFk).",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
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
        }
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
        }
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
        }
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
        }
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
        }
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
        }
      }
    ]
  };
});





/**
 * Start the server using stdio transport for local development
 * or HTTP transport for remote access (Azure App Service).
 */
async function main() {
    const port = process.env.PORT || process.env.HTTP_PORT;
    
    if (port) {
      // HTTP mode for Azure App Service - provides REST API endpoints only
      const app = express();
      // Ensure Express trusts proxy headers for accurate req.ip (Azure, etc.)
      app.set('trust proxy', true);
        
        // JSON body parser middleware
        app.use(express.json());
        
        // Initialize request logger for tracking AI Agent visits
        const connectionString = process.env.NOMADSTAYS_DB_CONNECTION || '';
        const requestLogger = new MCPRequestLogger(connectionString);
        
        // Add tracking middleware BEFORE routes
        app.use(createTrackingMiddleware(requestLogger));
        
        // CORS middleware - apply to all responses
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
            } else {
                // Allow all origins for API testing
                res.header('Access-Control-Allow-Origin', '*');
            }
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version');
            res.header('Access-Control-Allow-Credentials', 'true');
            res.header('Cache-Control', 'no-cache');
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
                return;
            }
            next();
        });
        
        // Health check endpoint
        app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                service: 'nomadstays-mcp25-dev',
                timestamp: new Date().toISOString(),
                version: '0.1.0',
                transport: 'streamable-http',
                endpoints: {
                    mcp: '/mcp',
                    health: '/health',
                    jsonrpc: '/ (POST for legacy support)'
                }
            });
        });

        // Initialize and add stats endpoints for tracking analytics
        const statsEndpoints = createStatsEndpoints(requestLogger);
        app.get('/api/mcp/stats/daily', statsEndpoints.getDailyStats);
        app.get('/api/mcp/stats/tools', statsEndpoints.getToolStats);
        app.get('/api/mcp/stats/detailed', statsEndpoints.getDetailedStats);

        // MCP Streamable HTTP endpoint - the modern transport
        app.post('/mcp', async (req, res) => {
            console.error('MCP StreamableHTTP request received:', req.method, req.url);
            
            try {
              // Set proper headers for streaming
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-cache');

              // Handle the MCP protocol message
              const request = req.body;
              console.error('MCP Request:', JSON.stringify(request, null, 2));

              // Validate JSON-RPC request
              if (!request || typeof request !== 'object' || !request.method) {
                return res.status(400).json({
                  jsonrpc: '2.0',
                  error: {
                    code: -32600,
                    message: 'Invalid Request'
                  },
                  id: request?.id || null
                });
              }

              // Handle notifications/initialized (and any notification)
              if (!('id' in request) && request.method === 'notifications/initialized') {
                // Notification: do nothing, return 204 No Content
                return res.status(204).end();
              }

              // Handle MCP protocol initialization
              if (request.method === 'initialize') {
                return res.json({
                  jsonrpc: '2.0',
                  result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                      tools: {},
                      resources: {}
                    },
                    serverInfo: {
                      name: 'nomadstays-mcp25-live',
                      version: '0.1.0'
                    }
                  },
                  id: request.id
                });
              }

              // Handle other MCP methods
              let result;

              switch (request.method) {
                    case 'tools/list': {
                      const toolsList = [
                        {
                          name: "getStaysByWiFiSpeed",
                          description: "Search for stays with minimum WiFi download speed (Mbps). Returns stays with WiFi speeds above the specified threshold.",
                          inputSchema: {
                            type: "object",
                            properties: {
                              minWiFiDownloadSpeed: {
                                type: "number",
                                description: "Minimum WiFi download speed in Mbps (default: 10)"
                              },
                              limit: {
                                type: "number",
                                description: "Maximum number of stays to return (default: 15)"
                              }
                            },
                            required: ["minWiFiDownloadSpeed"]
                          }
                        },
                            {
                                name: "getStaysByCountry",
                                description: "Search for nomad stays in a specific country by 2-letter country code or partial country name",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        countrycode: {
                                            type: "string",
                                            description: "2-letter ISO country code (e.g. 'ES', 'PT') OR partial country name"
                                        },
                                        limit: {
                                            type: "number",
                                            description: "Maximum number of stays to return (default: 15)"
                                        }
                                    }
                                }
                            },
                            {
                                name: "getStaysByContinent",
                                description: "Search for nomad stays by continent",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        continent: {
                                            type: "string",
                                            description: "Continent name (e.g., 'Europe', 'Asia', 'Africa')"
                                        },
                                        limit: {
                                            type: "number",
                                            description: "Maximum number of stays to return (default: 15)"
                                        }
                                    },
                                    required: ["continent"]
                                }
                            },
                            {
                                name: "getStayByID",
                                description: "Get detailed information about a specific stay by its ID",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        id: {
                                            type: "string",
                                            description: "The unique identifier of the stay"
                                        }
                                    },
                                    required: ["id"]
                                }
                            },
                            {
                                name: "getStaysByLocation",
                                description: "Search for stays by location (city/region name)",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        location: {
                                            type: "string",
                                            description: "City or region name to search for"
                                        },
                                        limit: {
                                            type: "number",
                                            description: "Maximum number of stays to return (default: 15)"
                                        }
                                    },
                                    required: ["location"]
                                }
                            },
                            {
                                name: "getStaysByLifestyle",
                                description: "Search for stays by lifestyle/genre category",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        lifestyle: {
                                            type: "string",
                                            description: "Lifestyle category (e.g., 'Digital Nomad', 'Beach Life')"
                                        },
                                        limit: {
                                            type: "number",
                                            description: "Maximum number of stays to return (default: 15)"
                                        }
                                    }
                                }
                            },
                            {
                                name: "getStaysByBudget",
                                description: "Search for stays within a budget and duration. Country is optional - searches globally if not specified.",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        countryCode: {
                                            type: "string",
                                            description: "2-letter country code or country name (OPTIONAL - omit to search all countries)"
                                        },
                                        durationDays: {
                                            type: "number",
                                            description: "Duration of stay in days (e.g., 30 for 1 month)"
                                        },
                                        maxPrice: {
                                            type: "number",
                                            description: "Maximum price for the entire duration"
                                        },
                                        currency: {
                                            type: "string",
                                            description: "Currency code (e.g., 'EUR', 'USD')"
                                        },
                                        checkInDate: {
                                            type: "string",
                                            description: "OPTIONAL: Check-in date. Can be a full date (e.g., '2026-05-15'), a month name (e.g., 'May' ? uses May 1st), or omit for today"
                                        },
                                        limit: {
                                            type: "number",
                                            description: "Maximum number of results (default: 15)"
                                        }
                                    },
                                    required: ["durationDays", "maxPrice", "currency"]
                                }
                            },
                            {
                                name: "getStaysByAmenities",
                                description: "Find stays that include specific amenities across stay- and room-level facilities. Supports 'any' or 'all' matching and optional WiFi speed filter.",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        amenities: {
                                            type: "array",
                                            items: { type: "string" },
                                            description: "Array of amenity names to search for (e.g., ['WiFi', 'Air Conditioning', 'Pool'])."
                                        },
                                        matchType: {
                                            type: "string",
                                            enum: ["any", "all"],
                                            description: "Match any amenity (default) or require all amenities"
                                        },
                                        minWifiSpeed: {
                                            type: "number",
                                            description: "Minimum WiFi download speed in Mbps (default: 0)"
                                        },
                                        limit: {
                                            type: "number",
                                            description: "Maximum number of results to return (default: 25)"
                                        }
                                    },
                                    required: ["amenities"]
                                }
                            },
                            {
                              name: "getAllLifestyles",
                              description: "Get all available lifestyle categories",
                              inputSchema: {
                                type: "object",
                                properties: {}
                              }
                            },
                            {
                              name: "getAllAmenities",
                              description: "List all possible amenities grouped into Stay vs Room (database-wide)",
                              inputSchema: {
                                type: "object",
                                properties: {}
                              }
                            },
                            {
                                name: "checkStayAvailability",
                                description: "Check if a specific stay is available for given check-in and check-out dates",
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
                                }
                            },
                            {
                                name: "findNearestAvailability",
                                description: "Find the nearest available dates when requested dates are not available",
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
                                }
                            },
                            {
                                name: "getAvailabilityByMonth",
                                description: "Get all available booking windows in a specific month",
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
                                }
                            },
                            {
                                name: "getRoomAvailability",
                                description: "Check which specific rooms at a stay are available for given dates",
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
                                        }
                                    },
                                    required: ["stayId", "checkIn", "checkOut"]
                                }
                            },
                            {
                                name: "getRoomAmenities",
                                description: "Get comprehensive list of all facilities and amenities for a specific room",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        roomId: {
                                            type: "string",
                                            description: "The unique identifier of the room"
                                        }
                                    },
                                    required: ["roomId"]
                                }
                            }
                        ];
                        
                        result = { tools: toolsList };
                        break;
                    }
                    
                    case 'tools/call': {
                        const toolName = request.params?.name;
                        const args = request.params?.arguments || {};
                        
                        const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                        let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                        connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                        
                        if (!connStr) {
                            throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set");
                        }
                        
                        let toolResult;
                        
                        switch (toolName) {
                                    case 'getStaysByWiFiSpeed': {
                                      const { getStaysByWiFiSpeed } = await import('./db/getStaysByWiFiSpeed.js');
                                      const stays = await getStaysByWiFiSpeed(connStr, {
                                        minWiFiDownloadSpeed: Number(args.minWiFiDownloadSpeed) || 10,
                                        limit: Number(args.limit) || 15
                                      });
                                      toolResult = stays;
                                      break;
                                    }
                            case 'getStaysByCountry': {
                                const { getStaysByCountry } = await import('./db/getStaysByCountry.js');
                                const stays = await getStaysByCountry(connStr, { 
                                    country: args.countrycode ?? null, 
                                    limit: Number(args.limit) || 15 
                                });
                                toolResult = stays;
                                break;
                            }
                            case 'getStaysByContinent': {
                                const { getStaysByContinent } = await import('./db/getStaysByContinent.js');
                                const stays = await getStaysByContinent(connStr, { 
                                    continent: args.continent, 
                                    limit: Number(args.limit) || 15 
                                });
                                toolResult = stays;
                                break;
                            }
                            case 'getStayByID': {
                                const { getStayByID } = await import('./db/getStayByID.js');
                                const stay = await getStayByID(connStr, args.id);
                                toolResult = stay;
                                break;
                            }
                            case 'getStaysByLocation': {
                                const { getStaysByLocation } = await import('./db/getStaysByLocation.js');
                                const stays = await getStaysByLocation(connStr, { 
                                    location: args.location, 
                                    limit: Number(args.limit) || 15 
                                });
                                toolResult = stays;
                                break;
                            }
                            case 'getStaysByLifestyle': {
                                const { getStaysByLifestyle } = await import('./db/getStaysByLifestyle.js');
                                const stays = await getStaysByLifestyle(connStr, { 
                                    lifestyle: args.lifestyle ?? null, 
                                    limit: Number(args.limit) || 15 
                                });
                                toolResult = stays;
                                break;
                            }
                            case 'getAllLifestyles': {
                              const { getAllLifestyles } = await import('./db/getAllLifestyles.js');
                              const lifestyles = await getAllLifestyles(connStr);
                                toolResult = lifestyles;
                                break;
                            }
                            case 'checkStayAvailability': {
                                const { checkStayAvailability } = await import('./db/checkStayAvailability.js');
                                const result = await checkStayAvailability(connStr, {
                                    stayId: args.stayId,
                                    checkIn: args.checkIn,
                                    checkOut: args.checkOut,
                                    roomType: args.roomType
                                });
                                toolResult = result;
                                break;
                            }
                            case 'findNearestAvailability': {
                                const { findNearestAvailability } = await import('./db/findNearestAvailability.js');
                                const result = await findNearestAvailability(connStr, {
                                    stayId: args.stayId,
                                    preferredCheckIn: args.preferredCheckIn,
                                    minLengthOfStay: Number(args.minLengthOfStay),
                                    maxLengthOfStay: args.maxLengthOfStay ? Number(args.maxLengthOfStay) : undefined,
                                    searchWindowDays: args.searchWindowDays ? Number(args.searchWindowDays) : undefined
                                });
                                toolResult = result;
                                break;
                            }
                            case 'getAvailabilityByMonth': {
                                const { getAvailabilityByMonth } = await import('./db/getAvailabilityByMonth.js');
                                const result = await getAvailabilityByMonth(connStr, {
                                    stayId: args.stayId,
                                    year: Number(args.year),
                                    month: Number(args.month),
                                    minLengthOfStay: Number(args.minLengthOfStay)
                                });
                                toolResult = result;
                                break;
                            }
                            case 'getRoomAvailability': {
                                const { getRoomAvailability } = await import('./db/getRoomAvailability.js');
                                const result = await getRoomAvailability(connStr, {
                                    roomId: args.roomId,
                                    checkIn: args.checkIn,
                                    checkOut: args.checkOut
                                });
                                toolResult = result;
                                break;
                            }
                            case 'getStaysByBudget': {
                                const { getStaysByBudget } = await import('./db/getStaysByBudget.js');
                                const stays = await getStaysByBudget(connStr, {
                                    countryCode: args.countryCode ?? null,
                                    durationDays: Number(args.durationDays),
                                    maxPrice: Number(args.maxPrice),
                                    currency: args.currency,
                                    checkInDate: args.checkInDate ?? null,
                                    limit: Number(args.limit) || 15
                                });
                                toolResult = stays;
                                break;
                            }
                            case 'getAllAmenities': {
                              const { getAllAmenities } = await import('./db/getAllAmenities.js');
                              const res = await getAllAmenities(connStr);
                              toolResult = res;
                              break;
                            }
                            default:
                                throw new Error(`Unknown tool: ${toolName}`);
                        }
                        
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(toolResult, null, 2)
                                }
                            ]
                        };
                        break;
                    }
                    
                    case 'resources/list': {
                        result = { resources: [] };
                        break;
                    }
                    
                    default:
                        return res.status(400).json({
                            jsonrpc: '2.0',
                            error: {
                                code: -32601,
                                message: 'Method not found'
                            },
                            id: request.id || null
                        });
                }
                
                // Return successful response
                res.json({
                    jsonrpc: '2.0',
                    result: result,
                    id: request.id
                });
                
            } catch (error: any) {
                console.error('MCP Error:', error);
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Internal error',
                        data: error?.message || String(error)
                    },
                    id: req.body?.id || null
                });
            }
        });
        
        // Root endpoint - serve index.html
        app.get('/', (req, res) => {
            res.sendFile('index.html', { root: '.' });
        });
        
        // JSON-RPC endpoint for MCP protocol
        app.post('/', async (req, res) => {
            try {
                const request = req.body;
                
                // Validate JSON-RPC request
                if (!request || typeof request !== 'object' || !request.method) {
                    return res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32600,
                            message: 'Invalid Request'
                        },
                        id: request?.id || null
                    });
                }
                
                // Handle MCP methods directly using the internal request handlers
                let result;
                
                try {
                    switch (request.method) {
                        case 'tools/list': {
                            // Return the list of available tools
                            result = {
                                tools: [
                                    {
                                        name: "getStaysByCountry",
                                        description: "Search for nomad stays in a specific country. Supports searching by 2-letter country code (e.g. 'ES', 'PT', 'TH') or by partial country name (e.g. 'Spain', 'Port', 'Thai'). Returns a maximum of 15 results. Use this tool when users ask about accommodations, stays, properties, or places to stay in a specific country or region.",
                                        inputSchema: {
                                            type: "object",
                                            properties: {
                                                countrycode: {
                                                    type: "string",
                                                    description: "Either a 2-letter ISO country code (e.g. 'ES', 'PT', 'TH') OR a partial country name (e.g. 'Spain', 'Port', 'Thai'). The search will match country codes exactly or search for country names containing this text."
                                                },
                                                limit: {
                                                    type: "number",
                                                    description: "Maximum number of stays to return (default: 15, max: 15)"
                                                }
                                            }
                                        }
                                    }
                                ]
                            };
                            break;
                        }
                        
                        case 'tools/call': {
                            const toolName = request.params?.name;
                            const args = request.params?.arguments || {};
                            
                            if (toolName === 'getStaysByCountry') {
                                const countrycode = args.countrycode ?? null;
                                const limit = Number(args.limit) || 15;
                                
                                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                                
                                if (!connStr) {
                                    throw new Error("Environment variable NOMADSTAYS_DB_CONNECTION must be set");
                                }
                                
                                const { getStaysByCountry } = await import('./db/getStaysByCountry.js');
                                const stays = await getStaysByCountry(connStr, { country: countrycode, limit });
                                
                                result = {
                                    content: [
                                        {
                                            type: "text",
                                            text: JSON.stringify(stays, null, 2)
                                        }
                                    ]
                                };
                            } else {
                                throw new Error(`Unknown tool: ${toolName}`);
                            }
                            break;
                        }
                        
                        case 'resources/list': {
                            result = {
                                resources: []
                            };
                            break;
                        }
                        
                        case 'resources/read': {
                            throw new Error('Resource read not yet implemented in JSON-RPC mode');
                        }
                        
                        case 'prompts/list': {
                            result = {
                                prompts: [
                                    {
                                        name: "summarize_notes",
                                        description: "Creates a summary of all notes",
                                        arguments: []
                                    }
                                ]
                            };
                            break;
                        }
                        
                        case 'prompts/get': {
                            throw new Error('Prompts not implemented');
                        }
                        
                        default:
                            return res.status(400).json({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32601,
                                    message: 'Method not found'
                                },
                                id: request.id || null
                            });
                    }
                    
                    // Return successful JSON-RPC response
                    res.json({
                        jsonrpc: '2.0',
                        result: result,
                        id: request.id || null
                    });
                    
                } catch (handlerError: any) {
                    console.error('Handler Error:', handlerError);
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal error',
                            data: handlerError?.message || String(handlerError)
                        },
                        id: request.id || null
                    });
                }
                
            } catch (error: any) {
                console.error('JSON-RPC Error:', error);
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32700,
                        message: 'Parse error',
                        data: error?.message || String(error)
                    },
                    id: null
                });
            }
        });
        
        // API endpoint for countries
        app.get('/api/countries', async (req, res) => {
            try {
                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                
                if (!connStr) {
                    return res.status(500).json({ 
                        error: "Environment variable NOMADSTAYS_DB_CONNECTION must be set" 
                    });
                }

                const { getAllCountries } = await import('./db/getStaysByCountry.js');
                const countries = await getAllCountries(connStr);
                
                res.json({ data: countries, count: countries.length });
            } catch (error: any) {
                console.error('API Error:', error);
                res.status(500).json({ 
                    error: `Failed to fetch countries: ${error?.message ?? String(error)}` 
                });
            }
        });
        
        // API endpoint for amenities
        app.get('/api/amenities', async (req, res) => {
            try {
                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                
                if (!connStr) {
                    return res.status(500).json({ 
                        error: "Environment variable NOMADSTAYS_DB_CONNECTION must be set" 
                    });
                }

                const { getAllAmenities } = await import('./db/getStaysByCountry.js');
                const amenities = await getAllAmenities(connStr);
                
                res.json({ data: amenities, count: amenities.length });
            } catch (error: any) {
                console.error('API Error:', error);
                res.status(500).json({ 
                    error: `Failed to fetch amenities: ${error?.message ?? String(error)}` 
                });
            }
        });
        
        // API endpoints for stays
        app.get('/api/stays', async (req, res) => {
            try {
                const { countrycode, limit } = req.query;
                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                
                if (!connStr) {
                    return res.status(500).json({ 
                        error: "Environment variable NOMADSTAYS_DB_CONNECTION must be set" 
                    });
                }

                const { getStaysByCountry } = await import('./db/getStaysByCountry.js');
                const stays = await getStaysByCountry(connStr, { 
                    country: countrycode ? String(countrycode) : null, 
                    limit: limit ? Number(limit) : 15 
                });
                
                res.json({ data: stays, count: stays.length });
            } catch (error: any) {
                console.error('API Error:', error);
                res.status(500).json({ 
                    error: `Failed to fetch stays: ${error?.message ?? String(error)}` 
                });
            }
        });

        app.get('/api/stays/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                
                if (!connStr) {
                    return res.status(500).json({ 
                        error: "Environment variable NOMADSTAYS_DB_CONNECTION must be set" 
                    });
                }

                const { getStayByID } = await import('./db/getStayByID.js');
                const stay = await getStayByID(connStr, id);
                
                if (!stay) {
                    return res.status(404).json({ error: `Stay ${id} not found` });
                }
                
                res.json({ data: stay });
            } catch (error: any) {
                console.error('API Error:', error);
                res.status(500).json({ 
                    error: `Failed to fetch stay: ${error?.message ?? String(error)}` 
                });
            }
        });
        
        
        // API endpoints for stays
        app.get('/api/stays', async (req, res) => {
            try {
                const { countrycode, limit } = req.query;
                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                
                if (!connStr) {
                    return res.status(500).json({ 
                        error: "Environment variable NOMADSTAYS_DB_CONNECTION must be set" 
                    });
                }

                const { getStaysByCountry } = await import('./db/getStaysByCountry.js');
                const stays = await getStaysByCountry(connStr, { 
                    country: countrycode ? String(countrycode) : null, 
                    limit: limit ? Number(limit) : 15 
                });
                
                res.json({ data: stays, count: stays.length });
            } catch (error: any) {
                console.error('API Error:', error);
                res.status(500).json({ 
                    error: `Failed to fetch stays: ${error?.message ?? String(error)}` 
                });
            }
        });

        app.get('/api/stays/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const connStrRaw = process.env.NOMADSTAYS_DB_CONNECTION ?? '';
                let connStr = String(connStrRaw).trim().replace(/^=+\s*/, '');
                connStr = connStr.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/;(\d+);/, ',$1;');
                
                if (!connStr) {
                    return res.status(500).json({ 
                        error: "Environment variable NOMADSTAYS_DB_CONNECTION must be set" 
                    });
                }

                const { getStayByID } = await import('./db/getStayByID.js');
                const stay = await getStayByID(connStr, id);
                
                if (!stay) {
                    return res.status(404).json({ error: `Stay ${id} not found` });
                }
                
                res.json({ data: stay });
            } catch (error: any) {
                console.error('API Error:', error);
                res.status(500).json({ 
                    error: `Failed to fetch stay: ${error?.message ?? String(error)}` 
                });
            }
        });
        
        app.listen(Number(port), () => {
            console.error(`HTTP API server listening on port ${port}`);
            console.error(`Health check: http://localhost:${port}/health`);
            console.error(`API endpoints: /api/countries, /api/amenities, /api/stays, /api/stays/:id`);
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

