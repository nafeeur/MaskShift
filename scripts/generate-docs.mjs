import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-docs-'));
const runtime = await createRuntime({ workspacePath: root, configOverrides: { home, autoIndex: false, autoOpen: false } });

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

try {
  const tools = runtime.toolRegistry.list({ includeSchema: false });
  const grouped = new Map();
  for (const tool of tools) {
    const values = grouped.get(tool.category || 'other') || [];
    values.push(tool);
    grouped.set(tool.category || 'other', values);
  }
  const toolLines = [
    '# Native Tool Inventory', '',
    `Generated from the MaskShift 1.0.0 runtime. **${tools.length} native tools** are available before plugins or MCP servers add more capabilities.`, '',
    'Only activated descriptors enter a model request; this document is the complete local catalog.', '',
  ];
  for (const [category, values] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    toolLines.push(`## ${category} (${values.length})`, '', '| Tool | Access | Risk | Description |', '|---|---|---|---|');
    for (const tool of values.sort((a, b) => a.name.localeCompare(b.name))) {
      toolLines.push(`| \`${cell(tool.name)}\` | ${tool.readOnly ? 'read' : 'write'} | ${cell(tool.risk || 'normal')} | ${cell(tool.description)} |`);
    }
    toolLines.push('');
  }
  await fsp.writeFile(path.join(root, 'docs', 'TOOLS.md'), `${toolLines.join('\n')}\n`);

  const skills = runtime.skillManager.list();
  const skillLines = [
    '# Bundled Skills', '',
    `MaskShift ships with **${skills.length} skills**. Descriptions are indexed at startup; full skill bodies are loaded only after activation.`, '',
    '| Skill | Description | Source |', '|---|---|---|',
  ];
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = skill.path ? path.relative(root, skill.path).replaceAll(path.sep, '/') : skill.source;
    skillLines.push(`| \`${cell(skill.name)}\` | ${cell(skill.description)} | \`${cell(relative)}\` |`);
  }
  skillLines.push('', 'Workspace and user skill directories can extend this catalog without modifying the core distribution.', '');
  await fsp.writeFile(path.join(root, 'docs', 'SKILLS.md'), skillLines.join('\n'));

  const portablePath = (value) => {
    if (!value || typeof value !== 'string') return value;
    if (value === root) return '${workspace}';
    if (value.startsWith(`${root}${path.sep}`)) return '${workspace}/' + path.relative(root, value).replaceAll(path.sep, '/');
    if (value === home) return '~/.maskshift';
    if (value.startsWith(`${home}${path.sep}`)) return '~/.maskshift/' + path.relative(home, value).replaceAll(path.sep, '/');
    return value;
  };
  const portable = (value) => {
    if (Array.isArray(value)) return value.map(portable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, portable(child)]));
    return portablePath(value);
  };
  const portableSkills = skills.map((skill) => ({
    ...skill,
    path: skill.path ? path.relative(root, skill.path).replaceAll(path.sep, '/') : skill.source,
    file: skill.file ? path.relative(root, skill.file).replaceAll(path.sep, '/') : undefined,
  }));
  const mcpServers = portable(runtime.mcpManager.listServers());
  const manifest = {
    generatedAt: new Date().toISOString(),
    version: '1.0.0',
    nativeToolCount: tools.length,
    bundledSkillCount: skills.length,
    curatedMcpCount: mcpServers.length,
    tools,
    skills: portableSkills,
    mcpServers,
  };
  await fsp.writeFile(path.join(root, 'docs', 'CAPABILITY-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated docs for ${tools.length} tools and ${skills.length} skills.`);
} finally {
  await runtime.close();
  await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
