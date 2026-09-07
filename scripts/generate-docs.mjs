import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';
import { VERSION } from '../src/core/utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledSkillsDir = path.join(root, 'skills');
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-docs-'));
// skillsDirs defaults include ~/.claude/skills and ~/.codex/skills, so a plain runtime here
// documents whatever the person running this happens to have installed — and writes their
// home directory into the published table. Scan the bundled directory and nothing else.
const runtime = await createRuntime({
  workspacePath: root,
  configOverrides: { home, autoIndex: false, skillsDirs: [bundledSkillsDir] },
});

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

// Nothing outside the repository may reach the generated docs.
function repoRelative(value, label) {
  if (!value) return value;
  const relative = path.relative(root, value);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to document a path outside the repository (${label}): ${value}`);
  }
  return relative.replaceAll(path.sep, '/');
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
    `Generated from the MaskShift ${VERSION} runtime. **${tools.length} native tools** are available before plugins or MCP servers add more capabilities.`, '',
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

  // Belt and braces: the config override above should make this a no-op, but a skill picked
  // up from anywhere else must never be published as one MaskShift ships.
  const skills = runtime.skillManager.list()
    .filter((skill) => !skill.path || !path.relative(bundledSkillsDir, skill.path).startsWith('..'));
  const skillLines = [
    '# Bundled Skills', '',
    `MaskShift ships with **${skills.length} skills**. Descriptions are indexed at startup; full skill bodies are loaded only after activation.`, '',
    '| Skill | Description | Source |', '|---|---|---|',
  ];
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = skill.path ? repoRelative(skill.path, skill.name) : skill.source;
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
  // updatedAt is the SKILL.md mtime, which is checkout time on a fresh clone — it says
  // nothing about the skill and makes the manifest differ on every machine. Dropped here
  // for the same reason generatedAt is: this file is committed and diffed by CI.
  const portableSkills = skills.map(({ updatedAt, ...skill }) => ({
    ...skill,
    path: skill.path ? repoRelative(skill.path, skill.name) : skill.source,
    file: skill.file ? repoRelative(skill.file, skill.name) : undefined,
  }));
  const mcpServers = portable(runtime.mcpManager.listServers());
  const manifest = {
    // No generation timestamp: the manifest is checked into the repository and CI verifies it
    // matches the code by regenerating and diffing. A field that changes on every run makes
    // that check impossible, and says nothing the commit history does not already record.
    version: VERSION,
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
