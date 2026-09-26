// Operator-defined slash commands: one Markdown file per command, whose body is a prompt
// template. `.maskshift/commands/review.md` becomes `/review`; `$ARGUMENTS` in the body is
// replaced with whatever follows the command. The same layout Claude Code uses under
// `.claude/commands`, so an existing command collection works here unchanged.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from '../agent/skills.mjs';

export function commandDirectories(workspacePath, home) {
  return [
    path.join(workspacePath, '.maskshift', 'commands'),
    path.join(workspacePath, '.claude', 'commands'),
    path.join(home, 'commands'),
    path.join(os.homedir(), '.claude', 'commands'),
  ];
}

/** Earlier directories win, so a project's own command shadows a personal one of the same name. */
export async function loadCustomCommands(directories, reserved = new Set()) {
  const found = new Map();
  for (const directory of directories) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || reserved.has(name) || found.has(name)) continue;
      const file = path.join(directory, entry.name);
      const content = await fsp.readFile(file, 'utf8').catch(() => null);
      if (content === null) continue;
      const { meta, body } = parseFrontmatter(content);
      const template = body.trim();
      if (!template) continue;
      const firstLine = template.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '') || name;
      found.set(name, { name, file, template, hint: String(meta.description || firstLine).slice(0, 60), custom: true });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(command, argument = '') {
  const text = String(argument || '').trim();
  if (command.template.includes('$ARGUMENTS')) return command.template.replaceAll('$ARGUMENTS', text);
  return text ? `${command.template}\n\n${text}` : command.template;
}
