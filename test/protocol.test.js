import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';

import { McpTestClient, SERVER_BIN, toolPayload } from './mcp-client.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOL_NAMES = ['mathematica_evaluate', 'mathematica_export', 'mathematica_kernel_status', 'mathematica_information'];

let client;

before(() => {
  client = new McpTestClient().start();
});

after(async () => {
  if (client) await client.close();
});

test('initialize negotiates a supported protocol version and returns server info', { timeout: 30_000 }, async () => {
  const response = await client.initialize({ protocolVersion: '2025-06-18' });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.deepEqual(response.result.capabilities.tools, {});
  assert.equal(response.result.serverInfo.name, 'mathematica-mcp');
  assert.equal(typeof response.result.serverInfo.version, 'string');
  assert.match(response.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof response.result.instructions, 'string');
  assert.match(response.result.instructions, /persistent/i);
  assert.match(response.result.instructions, /licen[cs]ed Mathematica|Wolfram Engine/i);
});

test('initialize echoes each supported protocol version', { timeout: 30_000 }, async () => {
  for (const protocolVersion of PROTOCOL_VERSIONS) {
    const other = new McpTestClient().start();
    try {
      const response = await other.request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'mathematica-mcp-tests', version: '0.0.0' },
      });
      assert.equal(response.result.protocolVersion, protocolVersion);
    } finally {
      await other.close();
    }
  }
});

test('initialize falls back to 2024-11-05 for an unknown protocol version', { timeout: 30_000 }, async () => {
  const other = new McpTestClient().start();
  try {
    const response = await other.request('initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: { name: 'mathematica-mcp-tests', version: '0.0.0' },
    });
    assert.equal(response.result.protocolVersion, '2024-11-05');
  } finally {
    await other.close();
  }
});

test('ping returns an empty result', { timeout: 30_000 }, async () => {
  const response = await client.request('ping');
  assert.deepEqual(response.result, {});
});

test('tools/list exposes exactly the four documented tools with valid schemas', { timeout: 30_000 }, async () => {
  const response = await client.request('tools/list', {});
  const tools = response.result.tools;
  assert.equal(tools.length, 4);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    TOOL_NAMES,
  );
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.inputSchema.properties, 'object');
  }
  const evaluate = tools.find((tool) => tool.name === 'mathematica_evaluate');
  assert.deepEqual(evaluate.inputSchema.required, ['code']);
  const exportTool = tools.find((tool) => tool.name === 'mathematica_export');
  assert.deepEqual(exportTool.inputSchema.required, ['code', 'format']);
  assert.deepEqual(exportTool.inputSchema.properties.format.enum, ['png', 'svg', 'pdf', 'csv', 'txt', 'json', 'tex']);
  const statusTool = tools.find((tool) => tool.name === 'mathematica_kernel_status');
  assert.deepEqual(statusTool.inputSchema.properties.action.enum, ['status', 'restart', 'interrupt']);
  const informationTool = tools.find((tool) => tool.name === 'mathematica_information');
  assert.deepEqual(informationTool.inputSchema.required, ['symbols']);
});

test('resources/list and prompts/list return empty lists', { timeout: 30_000 }, async () => {
  assert.deepEqual((await client.request('resources/list')).result, { resources: [] });
  assert.deepEqual((await client.request('prompts/list')).result, { prompts: [] });
});

test('unknown methods return JSON-RPC error -32601', { timeout: 30_000 }, async () => {
  const response = await client.request('math/does-not-exist', {});
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Method not found/);
});

test('malformed JSON returns JSON-RPC parse error -32700', { timeout: 30_000 }, async () => {
  client.sendRaw('{ this is definitely not JSON\n');
  const frame = await client.waitForFrame((message) => message && message.error && message.error.code === -32700);
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.id, null);
  assert.match(frame.error.message, /Parse error/);
});

test('a request without a method returns invalid request -32600', { timeout: 30_000 }, async () => {
  client.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 4242, params: {} })}\n`);
  const frame = await client.waitForFrame((message) => message && message.id === 4242);
  assert.equal(frame.error.code, -32600);
});

test('tools/call with an unknown tool returns an isError result with a clear message', { timeout: 30_000 }, async () => {
  const response = await client.callTool('definitely_not_a_tool', {});
  assert.equal(response.result.isError, true);
  const payload = toolPayload(response);
  assert.match(payload.message, /Unknown tool: "?definitely_not_a_tool"?/);
  assert.match(payload.message, /mathematica_evaluate/);
});

test('tools/call without a tool name returns invalid params -32602', { timeout: 30_000 }, async () => {
  const response = await client.request('tools/call', {});
  assert.equal(response.error.code, -32602);
});

test('tool argument validation returns isError results without starting the kernel', { timeout: 30_000 }, async () => {
  const invalidFormat = await client.callTool('mathematica_export', { code: 'Plot[x, {x, 0, 1}]', format: 'gif' });
  assert.equal(invalidFormat.result.isError, true);
  assert.match(toolPayload(invalidFormat).message, /format/);

  const emptyCode = await client.callTool('mathematica_evaluate', { code: '   ' });
  assert.equal(emptyCode.result.isError, true);
  assert.match(toolPayload(emptyCode).message, /code/);

  const badSymbol = await client.callTool('mathematica_information', { symbols: ['not a symbol!'] });
  assert.equal(badSymbol.result.isError, true);
  assert.match(toolPayload(badSymbol).message, /Invalid symbol name/);
});

test('notifications are accepted without a response', { timeout: 30_000 }, async () => {
  const frameCountBefore = client.frames.length;
  client.notify('notifications/initialized');
  const response = await client.request('ping');
  assert.deepEqual(response.result, {});
  const newFrames = client.frames.slice(frameCountBefore);
  assert.ok(newFrames.every((frame) => Object.prototype.hasOwnProperty.call(frame, 'id')), 'no response frame for a notification');
});

test('stdout contains protocol frames only (nothing but newline-delimited JSON)', { timeout: 30_000 }, async () => {
  // Send a few more requests to exercise the stream, then assert every line was JSON.
  await client.request('ping');
  await client.request('tools/list');
  assert.deepEqual(client.invalidStdoutLines, []);
  assert.ok(client.stdoutLines.length >= 3);
  for (const line of client.stdoutLines) {
    assert.doesNotThrow(() => JSON.parse(line), `stdout line is not JSON: ${line}`);
  }
});

test('CLI --version and --help work without starting the server', { timeout: 30_000 }, () => {
  const version = execFileSync(process.execPath, [SERVER_BIN, '--version'], { encoding: 'utf8' });
  assert.match(version, /^mathematica-mcp \d+\.\d+\.\d+\r?\n$/);
  const help = execFileSync(process.execPath, [SERVER_BIN, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage:/);
  assert.match(help, /MATHEMATICA_EXE/);
});
