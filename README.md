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

## Setup

### 1. Prerequisites

- Node.js 20+
- Access to a NomadStays Azure SQL database

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

## Deploy to Azure App Service

An ARM template is included for one-click deployment:

```bash
az deployment group create \
  --resource-group your-resource-group \
  --template-file azure-deploy.json \
  --parameters dbConnectionString="your-connection-string"
```

## Tech stack

- TypeScript + Node.js 20
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- Express (HTTP mode)
- mssql (Azure SQL connectivity)
