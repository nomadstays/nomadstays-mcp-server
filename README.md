# NomadStays MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives AI agents access to NomadStays accommodation data — search by country, continent, location, lifestyle, budget, amenities, and availability.

Compatible with **Claude**, **ChatGPT**, and any MCP-aware AI agent.

## Tools available

| Tool | Description |
|---|---|
| `getStaysByCountry` | Search stays by 2-letter country code or country name |
| `getStaysByContinent` | Search by continent (Europe, Asia, Africa, etc.) |
| `getStaysByLocation` | Free-text search across city, region, location description |
| `getStaysByLifestyle` | Filter by lifestyle category (Digital Nomad, Beach, City…) |
| `getStaysByBudget` | Find stays within a budget for a given duration and currency |
| `getStaysByAmenities` | Filter by amenities (WiFi, Pool, Air Conditioning…) |
| `getStaysByWiFiSpeed` | Filter by minimum WiFi download speed (Mbps) |
| `getStayByID` | Full details for a single stay |
| `getAllLifestyles` | List all available lifestyle categories |
| `getAllAmenities` | List all available amenities |
| `checkStayAvailability` | Check if a stay is available for given dates |
| `findNearestAvailability` | Find nearest available dates when preferred dates are taken |
| `getAvailabilityByMonth` | All available windows in a specific month |
| `getRoomAvailability` | Per-room availability for a date range |
| `getRoomAmenities` | Full amenity list for a specific room including WiFi metrics |
| `searchHelpCenter` | Search NomadStays help centre articles |
| `getHelpCenterArticle` | Fetch a specific help article by ID |
| `listHelpCenterCategories` | List all help centre categories |

## Trusted stay partner management tools

The tools above are read-only and public. A separate set of tools lets an **authorized trusted stay partner's own AI agent** read AND write their own listing data — with the same capabilities (no more, no less) as they have via the NomadStays admin UI. These require a bearer token issued at `nomadstays.com/siteadmin/mcp-tokens-admin` (2FA must be enabled on the account to request one), set as `NOMADSTAYS_MCP_AGENT_TOKEN`. Every call is scoped server-side to Stays the authenticated account actually owns.

| Tool | Description |
|---|---|
| `getMyStays` / `getMyStayDetail` / `updateStayDetail` | Read/update a Stay's core details (title, description, address, policies) |
| `getMyStayRooms` / `createStayRoom` / `updateStayRoom` / `deleteStayRoom` | Full room CRUD, including bed sizes, facilities, and photos |
| `getRoomTypeOptions` / `getRoomFacilityOptions` | Reference lookups for valid room types/facilities (differ for boutique vs standard Stays) |
| `uploadStayPhoto` / `getMyStayPhotos` / `deleteStayPhoto` / `reorderStayPhotos` | Stay-level photo management, including reordering |
| `deleteRoomPhoto` / `reorderRoomPhotos` | Room-level photo management |
| `getMyStayPackages` / `createStayPackage` / `updateStayPackage` / `deleteStayPackage` | Pricing package CRUD — `sellPrice` is always server-computed, never directly settable |
| `getCurrencyOptions` / `getBusinessModelOptions` | Reference lookups for package currency and business model |
| `getMyStayOrganisationalData` / `updateStayOrganisationalData` | Address, check-in/out policy, cancellation policy, pets/children/parking rules |
| `getStayTypeOptions` / `getCountryOptions` / `getCancellationPolicyOptions` / `getAdditionalInformationOptions` | Reference lookups for organisational-data fields |
| `getMyStayContacts` / `updateStayContacts` | Public-facing contact details |
| `getMyStayFacilities` / `updateStayFacilities` / `getFacilityGroups` | Facility checkboxes, grouped exactly as on the admin UI |
| `getMyBusinessProfile` / `updateHostBusinessProfile` | Business profile (excludes bank/tax fields — never exposed via MCP) |

Key rules: boutique Stays (`Boutique1`–`Boutique6` room types) and standard Stays are validated separately — always call `getRoomTypeOptions` first. Package price tiers are locked to 7/14/21/30 nights and don't all need to be set — a subset (e.g. 1-week-only) is valid. `advertisingEndpoint` only applies to Advertising-business-model Stays. Bank and tax details are permanently excluded from every tool.

## Setup

### 1. Prerequisites

- Node.js 20+
- Access to a NomadStays SQL Server database (hosted on Coolify/Hetzner)

### 2. Install

```bash
git clone https://github.com/nomadstays/nomadstays-mcp-server.git
cd nomadstays-mcp-server
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env and set your NOMADSTAYS_DB_CONNECTION string
```

### 4. Build

```bash
npm run build
```

### 5. Run (stdio mode — for Claude Desktop / local MCP clients)

```bash
node build/index.js
```

### 6. Run (HTTP mode — for hosted / remote deployments)

```bash
PORT=8080 node build/index.js
```

HTTP endpoints:
- `POST /mcp` — MCP Streamable HTTP transport
- `GET /health` — Health check
- `GET /api/mcp/stats/daily` — Daily usage stats
- `GET /api/mcp/stats/tools` — Per-tool usage stats

## Claude Desktop configuration

Copy `claude_desktop_config.example.json`, update the path and connection string, then merge into your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nomadstays": {
      "command": "node",
      "args": ["/path/to/nomadstays-mcp-server/build/index.js"],
      "env": {
        "NOMADSTAYS_DB_CONNECTION": "Server=tcp:..."
      }
    }
  }
}
```

## Deploy

The production NomadStays deployment runs its MCP servers as Docker containers on **Coolify** (self-hosted on Hetzner) rather than Azure App Service. This repo doesn't include a Dockerfile of its own — containerize it with a standard Node.js build (Node 20+, `npm run build`, run `dist/index.js`) and deploy to any Docker-capable host, setting `NOMADSTAYS_DB_CONNECTION` (and `PORT`/`HTTP_PORT` for HTTP mode) as environment variables on the target platform.

## Tech stack

- TypeScript + Node.js 20
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- Express (HTTP mode)
- mssql (SQL Server connectivity)
