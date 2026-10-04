import assert from 'node:assert/strict';
import test from 'node:test';
import { curatedMcpCatalog } from '../src/mcp/discovery.mjs';

test('the built-in MCP catalogue is well formed', () => {
  const names = curatedMcpCatalog.map((server) => server.name);
  assert.equal(new Set(names).size, names.length, 'server names are unique');
  assert.ok(curatedMcpCatalog.length >= 40);
  for (const server of curatedMcpCatalog) {
    assert.match(server.name, /^[a-z0-9][a-z0-9._-]*$/, server.name);
    assert.ok(server.description && server.keywords?.length, `${server.name} is searchable`);
    assert.equal(server.source, 'curated');
    assert.equal(server.lazy, true, `${server.name} must not start until activated`);
    if (server.transport === 'http') assert.match(server.url, /^https:\/\//, `${server.name} uses TLS`);
    else assert.ok(server.command && Array.isArray(server.args), `${server.name} has a command`);
  }
});

test('servers that need a credential are off by default and never embed one', () => {
  for (const server of curatedMcpCatalog.filter((item) => item.requires)) {
    assert.equal(server.enabled, false, `${server.name} needs ${server.requires.join(', ')}`);
    const wiring = JSON.stringify([server.headers, server.env, server.bearerToken]);
    for (const variable of server.requires) {
      assert.ok(wiring.includes(`\${${variable}}`), `${server.name} reads ${variable} from the environment`);
      assert.ok(server.description.includes(variable), `${server.name} tells the user to set ${variable}`);
    }
    assert.doesNotMatch(wiring, /sk-|ghp_|Bearer [A-Za-z0-9]{12,}/);
  }
  for (const server of curatedMcpCatalog.filter((item) => item.oauth)) assert.equal(server.enabled, false, server.name);
});
