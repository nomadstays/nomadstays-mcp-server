#!/usr/bin/env node
/**
 * HTTP Shim for NomadStays MCP Server
 *
 * Behavior:
 * - If `./build/index.js` is present, load it (run the real server).
 * - Otherwise, run a lightweight HTTP shim that exposes a basic /health and info endpoints.
 */

import { createServer } from 'http';
import { existsSync, readFileSync } from 'fs';

const PORT = process.env.PORT || 8080;

(async function main() {
  try {
    // If a built server exists, import it and call its exported starter
    // so it runs in-process (avoids cross-instance child-process race).
    const mod = await import('./build/index.js');
    if (mod?.startServer && typeof mod.startServer === 'function') {
      console.log('Starting built server in-process via startServer()');
      await mod.startServer();
      return;
    }
    // If no startServer export, fall back to spawning as a compatibility fallback
    const { spawn } = await import('child_process');
    const node = process.execPath || 'node';
    const child = spawn(node, ['./build/index.js'], { stdio: 'inherit', env: process.env });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.log(`Child exited with signal ${signal}`);
        process.exit(1);
      }
      console.log(`Child exited with code ${code}`);
      process.exit(code ?? 0);
    });
    child.on('error', (err) => {
      console.warn('Failed to start built server child process:', err?.message ?? err);
    });
    console.log('Spawned node ./build/index.js — delegating to built server.');
    return;
  }
  catch (err) {
    console.warn('build/index.js not available or failed to start, falling back to HTTP shim:', err?.message ?? err);
  }

  // Fallback shim
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: process.env.npm_package_name || 'nomadstays-mcp-server',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '0.1.0'
      }));
      return;
    }

    if (req.url === '/') {
      if (existsSync('./index.html')) {
        const html = readFileSync('./index.html', 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: process.env.npm_package_name || 'nomadstays-mcp-server',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '0.1.0'
      }));
      return;
    }

    if (req.url && (req.url.startsWith('/mcp') || req.url.startsWith('/api'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'MCP shim: build/index.js not present',
        note: 'Deploy build/ or ensure build/index.js is present to enable full MCP functionality',
        health: '/health'
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', availableEndpoints: ['/health', '/'] }));
  });

  server.listen(PORT, () => {
    console.log(`🚀 NomadStays MCP HTTP Shim listening on port ${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = (sig) => {
    console.log(`${sig} received: closing HTTP server`);
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
