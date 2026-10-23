/**
 * Minimal MCP stdio test client used by the integration tests.
 *
 * It spawns `bin/mathematica-mcp.js` as a child process and speaks raw
 * newline-delimited JSON-RPC 2.0 over its stdin/stdout. Every stdout line is
 * recorded so tests can assert that the protocol stream is clean JSON.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectKernel, resolveKernel } from '../src/detect.js';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_BIN = join(PACKAGE_ROOT, 'bin', 'mathematica-mcp.js');

/** Reason string used when the kernel integration tests are skipped. */
export function kernelSkipReason() {
  if (process.env.MATHEMATICA_MCP_TEST_SKIP_KERNEL === '1') {
    return 'MATHEMATICA_MCP_TEST_SKIP_KERNEL=1 is set, so kernel integration tests are skipped.';
  }
  return 'No working Mathematica kernel found on this machine; set MATHEMATICA_EXE (or MATHEMATICA_MCP_TEST_KERNEL) to run kernel integration tests.';
}

/**
 * Locate a Mathematica kernel for the integration tests (synchronous, best
 * effort; use `resolveTestKernel()` to also verify that it is licensed).
 *
 * Returns `null` (so the tests skip) when:
 *  - MATHEMATICA_MCP_TEST_SKIP_KERNEL=1 is set, or
 *  - MATHEMATICA_MCP_TEST_KERNEL points at a path that does not exist, or
 *  - no kernel can be detected on this machine.
 */
export function findTestKernel() {
  if (process.env.MATHEMATICA_MCP_TEST_SKIP_KERNEL === '1') return null;
  const override = process.env.MATHEMATICA_MCP_TEST_KERNEL;
  if (override) return existsSync(override) ? override : null;
  const detected = detectKernel({ env: process.env });
  if (detected && existsSync(detected.path)) return detected.path;
  return null;
}

/**
 * Resolve and license-probe a kernel for the integration tests.
 * Returns `null` when tests should be skipped.
 */
export async function resolveTestKernel() {
  if (process.env.MATHEMATICA_MCP_TEST_SKIP_KERNEL === '1') return null;
  const override = process.env.MATHEMATICA_MCP_TEST_KERNEL || process.env.MATHEMATICA_EXE;
  if (override) return existsSync(override) ? override : null;
  const resolution = await resolveKernel({ env: process.env, homeDir: join(tmpdir(), 'mathematica-mcp-test-home') });
  return resolution.ok ? resolution.path : null;
}

export class McpTestClient {
  constructor({ kernelPath = null, env = {}, requestTimeoutMs = 180_000 } = {}) {
    this._kernelPath = kernelPath;
    this._env = env;
    this._defaultRequestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.stderrText = '';
    this.stdoutLines = [];
    this.invalidStdoutLines = [];
    this.frames = [];
    this._buffer = '';
    this._pending = new Map();
    this._nextId = 1;
    this.exitInfo = null;
    this._exitPromise = null;
  }

  start() {
    const env = { ...process.env, ...this._env };
    if (this._kernelPath) env.MATHEMATICA_EXE = this._kernelPath;
    this.child = spawn(process.execPath, [SERVER_BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrText += chunk;
    });
    this._exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    return this;
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this._buffer = this._buffer.slice(newlineIndex + 1);
      this.stdoutLines.push(line);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.invalidStdoutLines.push(line);
        continue;
      }
      this.frames.push(message);
      if (message && message.id !== undefined && message.id !== null && this._pending.has(message.id)) {
        const pending = this._pending.get(message.id);
        this._pending.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  /** Wait for an unsolicited frame (e.g. a JSON-RPC error for malformed input). */
  async waitForFrame(predicate, { timeoutMs = 5000 } = {}) {
    const existing = this.frames.find((frame) => {
      try {
        return predicate(frame);
      } catch {
        return false;
      }
    });
    if (existing) return existing;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const match = this.frames.find((frame) => {
        try {
          return predicate(frame);
        } catch {
          return false;
        }
      });
      if (match) return match;
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for a matching protocol frame.`);
  }

  send(frame) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('MCP client is not running.');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method, params, { timeoutMs = null } = {}) {
    const id = this._nextId;
    this._nextId += 1;
    const frame = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame.params = params;
    const limit = timeoutMs === null ? this._defaultRequestTimeoutMs : timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timed out after ${limit} ms waiting for the "${method}" response.`));
      }, limit);
      if (timer.unref) timer.unref();
      this._pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      this.send(frame);
    });
  }

  notify(method, params) {
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    this.send(frame);
  }

  sendRaw(text) {
    this.child.stdin.write(text);
  }

  async initialize({ protocolVersion = '2025-06-18' } = {}) {
    const response = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'mathematica-mcp-tests', version: '0.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async toolsList() {
    const response = await this.request('tools/list', {});
    return response;
  }

  async callTool(name, args, options = {}) {
    return this.request('tools/call', { name, arguments: args }, options);
  }

  /** Wait for the server process to exit (after closing stdin). */
  async close() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      if (timer.unref) timer.unref();
    });
    const exited = await Promise.race([this._exitPromise, timeout]);
    if (!exited && this.child.exitCode === null) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      await Promise.race([this._exitPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
  }
}

/** True when a JSON-RPC response is a protocol error with the given code. */
export function rpcErrorCode(response) {
  return response && response.error ? response.error.code : null;
}

/** Parse the JSON payload of a tools/call result's first text content block. */
export function toolPayload(response) {
  const content = response && response.result && Array.isArray(response.result.content) ? response.result.content : [];
  const textBlock = content.find((block) => block && block.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') return null;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { raw: textBlock.text };
  }
}
