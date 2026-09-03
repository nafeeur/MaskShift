import readline from 'node:readline';

const mode = process.argv[2] || 'modern';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(message, 'id')) return;
  const { id, method, params = {} } = message;
  if (method === 'server/discover') {
    if (mode === 'legacy') return error(id, -32601, 'Method not found');
    if (!params._meta?.['io.modelcontextprotocol/protocolVersion']) return error(id, -32602, 'Missing modern metadata');
    return result(id, {
      serverInfo: { name: 'maskshift-modern-fixture', version: '1.0.0' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: 'Fixture modern MCP server',
    });
  }
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'maskshift-legacy-fixture', version: '1.0.0' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: 'Fixture legacy MCP server',
    });
  }
  if (method === 'tools/list') return result(id, { tools: [{ name: 'echo', description: 'Echo arguments', inputSchema: { type: 'object', properties: { value: {} } } }] });
  if (method === 'tools/call') return result(id, { content: [{ type: 'text', text: JSON.stringify(params.arguments || {}) }], structuredContent: params.arguments || {} });
  if (method === 'resources/list') return result(id, { resources: [{ uri: 'fixture://status', name: 'status', mimeType: 'text/plain' }] });
  if (method === 'resources/read') return result(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'MCP_RESOURCE_OK' }] });
  if (method === 'prompts/list') return result(id, { prompts: [{ name: 'verify', description: 'Verification prompt', arguments: [] }] });
  if (method === 'prompts/get') return result(id, { description: 'Verification prompt', messages: [{ role: 'user', content: { type: 'text', text: 'VERIFY_OK' } }] });
  if (method === 'ping') return result(id, {});
  return error(id, -32601, `Unknown method: ${method}`);
});

process.stdin.on('end', () => process.exit(0));
