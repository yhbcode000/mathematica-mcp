#!/usr/bin/env node
/**
 * mathematica-mcp - MCP server for a local Wolfram Language kernel.
 *
 * This is the executable entry point declared in package.json ("bin"). It only
 * wires up diagnostics and delegates to src/server.js.
 */

import { main } from '../src/server.js';

process.on('uncaughtException', (error) => {
  process.stderr.write(`[mathematica-mcp] uncaught exception: ${error && error.stack ? error.stack : error}\n`);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[mathematica-mcp] unhandled rejection: ${reason && reason.stack ? reason.stack : reason}\n`);
});

main().catch((error) => {
  process.stderr.write(`[mathematica-mcp] fatal: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
