// Deterministic LSP protocol fixture, not a real semantic language server.
let buffer = Buffer.alloc(0);
const range = { start: { line: 0, character: 16 }, end: { line: 0, character: 24 } };
function reply(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function handle(message) {
  const { id, method, params } = message;
  if (method === 'exit') return process.exit(0);
  if (id === undefined) return;
  const uri = params?.textDocument?.uri;
  switch (method) {
    case 'initialize': return reply(id, { capabilities: { hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, renameProvider: true, documentFormattingProvider: true, diagnosticProvider: {} } });
    case 'textDocument/hover': return reply(id, { contents: { kind: 'plaintext', value: 'velocity: fixture function' } });
    case 'textDocument/definition':
    case 'textDocument/references': return reply(id, [{ uri, range }]);
    case 'textDocument/documentSymbol': return reply(id, [{ name: 'velocity', kind: 12, range, selectionRange: range }]);
    case 'textDocument/diagnostic': return reply(id, { kind: 'full', items: [{ range, severity: 3, message: 'Fixture diagnostic' }] });
    case 'textDocument/rename': return reply(id, { changes: { [uri]: [{ range, newText: params.newName }] } });
    case 'textDocument/formatting': return reply(id, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// formatted\n' }]);
    default: return reply(id, null);
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const header = buffer.indexOf('\r\n\r\n');
    if (header < 0) return;
    const length = Number(buffer.subarray(0, header).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length));
    buffer = buffer.subarray(header + 4 + length);
    handle(message);
  }
});
