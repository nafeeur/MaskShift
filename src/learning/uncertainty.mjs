// Knowing when to ask instead of act.
//
// In the autonomous permission mode nothing asks before running a command. That is the point of it — and also how a model
// that is only 90% sure ends up force-pushing a branch or dropping a table. This looks at what a call would actually do,
// separates the things a checkpoint can undo from the things nothing can, and for the latter makes the run ask first (or stop,
// with the reason, when nobody is there to ask). Everything else passes untouched, so it costs nothing on ordinary work.

import path from 'node:path';

const HOME_ROOTS = /^(?:~|\$HOME|\$\{HOME\}|\/|\/\*|\.\.(?:\/\.\.)*\/?|\*)$/;
const SAFE_TARGETS = /(^|\/)(node_modules|dist|build|target|\.cache|\.next|coverage|__pycache__|tmp|\.venv|\.maskshift)(\/|$)/;

const HIGH = [
  [/\bgit\s+push\b[^|;&]*(?:--force(?!-with-lease)|\s-f\b)/, 'force-pushes, which overwrites remote history'],
  [/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, 'drops or empties database data'],
  [/\bdelete\s+from\s+\w+\s*(?:;|$|--)/i, 'deletes every row of a table (no WHERE clause)'],
  [/\bmkfs(?:\.\w+)?\b|\bdd\b[^|;&]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|disk)/, 'writes directly to a disk device'],
  [/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, 'pipes a download straight into a shell'],
  [/\b(?:npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgem\s+push\b/, 'publishes a package or image publicly'],
  [/\bterraform\s+(?:apply|destroy)\b|\bkubectl\s+(?:delete|apply|replace)\b|\bhelm\s+(?:uninstall|delete)\b/, 'changes live infrastructure'],
  [/\baws\s+\S+\s+(?:rm|delete|terminate|remove)\b|\bgcloud\b[^|;&]*\bdelete\b|\baz\b[^|;&]*\bdelete\b/, 'deletes cloud resources'],
  [/\b(?:shutdown|reboot|halt|poweroff)\b|\bsystemctl\s+(?:poweroff|reboot|halt)\b/, 'shuts down or restarts the machine'],
  [/\bchmod\s+-R\s+[0-7]+\s+\/(?:\s|$)|\bchown\s+-R\b[^|;&]*\s\/(?:\s|$)/, 'changes permissions across the filesystem'],
];
const CAUTION = [
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--\s|restore\s+\.|branch\s+-D)\b/, 'discards uncommitted work or a branch'],
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\bsudo\b/, 'runs with elevated privileges'],
  [/\b(?:npm|pip3?|brew|apt(?:-get)?|dnf|cargo)\s+(?:install|uninstall|remove)\s+-g\b|\bpip3?\s+install\b[^|;&]*--break-system-packages/, 'changes software installed system-wide'],
  [/\bdocker\s+system\s+prune\b|\bdocker\s+(?:rm|rmi|volume\s+rm)\b/, 'removes containers, images or volumes'],
];

function rmFindings(command, workspacePath) {
  const out = [];
  for (const piece of command.split(/&&|;|\|\|/)) {
    const tokens = piece.trim().split(/\s+/);
    const at = tokens.findIndex((token) => token === 'rm' || token.endsWith('/rm'));
    if (at < 0) continue;
    const flags = tokens.slice(at + 1).filter((token) => token.startsWith('-')).join('');
    if (!/r|R/.test(flags) && !/--recursive/.test(flags)) continue;
    for (const target of tokens.slice(at + 1).filter((token) => !token.startsWith('-'))) {
      const clean = target.replace(/^["']|["']$/g, '');
      if (HOME_ROOTS.test(clean)) { out.push(['high', `recursively deletes \`${clean}\``]); continue; }
      if (SAFE_TARGETS.test(clean)) continue;
      const absolute = clean.startsWith('/') || clean.startsWith('~');
      if (absolute && workspacePath && !path.resolve(clean.replace(/^~/, process.env.HOME || '~')).startsWith(path.resolve(workspacePath))) out.push(['high', `recursively deletes \`${clean}\`, outside this workspace`]);
      else if (/\*/.test(clean) && /^\.?\/?\*/.test(clean)) out.push(['caution', `recursively deletes \`${clean}\``]);
    }
  }
  return out;
}

/** @returns { level: 'none'|'caution'|'high', reasons: string[] } */
export function assessCommand(command, { workspacePath = '' } = {}) {
  const text = String(command || '');
  const reasons = [];
  let level = 'none';
  const bump = (to, why) => { reasons.push(why); if (to === 'high') level = 'high'; else if (level === 'none') level = 'caution'; };
  for (const [to, why] of rmFindings(text, workspacePath)) bump(to, why);
  for (const [pattern, why] of HIGH) if (pattern.test(text)) bump('high', why);
  if (level !== 'high') for (const [pattern, why] of CAUTION) if (pattern.test(text)) bump('caution', why);
  return { level, reasons };
}

const SENSITIVE_PATHS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud|\.bashrc|\.zshrc|\.profile|\.bash_profile|authorized_keys|id_rsa|id_ed25519|\.netrc|\.npmrc|sudoers)(\/|$)|^\/(etc|boot|usr|bin|sbin|lib|var\/lib)\//;

export function assessCall({ name, args = {}, workspacePath = '', readInRun = new Set() }) {
  if (name === 'shell_exec' || name === 'shell_run' || name === 'process_start') return assessCommand(args.command, { workspacePath });
  if (['fs_write', 'fs_patch', 'fs_replace_lines', 'symbol_replace', 'fs_delete', 'fs_move'].includes(name)) {
    const target = String(args.path || args.file || '');
    const absolute = target.startsWith('~') ? target.replace(/^~/, process.env.HOME || '~') : target;
    if (SENSITIVE_PATHS.test(absolute)) return { level: 'high', reasons: [`modifies \`${target}\`, a credential, shell or system file`] };
    if (name === 'fs_delete' && /\brecursive\b|true/.test(String(args.recursive))) return { level: 'caution', reasons: [`recursively deletes \`${target}\``] };
    if (name === 'fs_write' && args.path && !readInRun.has(String(args.path).replace(/^\.\//, '')) && args.overwrite !== false && args.mode !== 'create') {
      return { level: 'caution', reasons: [`writes \`${target}\` without having read it in this run; if it already exists its contents will be replaced`] };
    }
  }
  return { level: 'none', reasons: [] };
}

const VAGUE_VERB = /^(?:please\s+)?(?:fix|improve|clean(?:\s*up)?|update|change|make|do|handle|refactor|optimi[sz]e|redo|finish)\b/i;
const DEICTIC = /\b(?:it|this|that|these|those|them|the thing|the issue|the bug|the problem|the other one|same as before)\b/i;
const CONCRETE = /[\w-]+\.[a-z]{1,5}\b|[\\/][\w.-]+|`[^`]+`|\b[A-Z][a-z]+[A-Z]\w*\b|\b\w+_\w+\b|\bhttps?:\/\//;

/** Is the request too thin to act on without guessing? Cheap and deliberately conservative: it only advises. */
export function assessPrompt(prompt, { hasHistory = false } = {}) {
  const text = String(prompt || '').trim();
  const reasons = [];
  if (!text || hasHistory) return { ambiguous: false, reasons };
  const words = text.split(/\s+/).length;
  if (words <= 8 && VAGUE_VERB.test(text) && !CONCRETE.test(text)) reasons.push('names an action but not what it applies to');
  if (words <= 12 && DEICTIC.test(text) && !CONCRETE.test(text)) reasons.push('refers to something ("it", "that") that this conversation has not established');
  if (/\b(?:or|either)\b[^.?!]*\?/.test(text) && words <= 20) reasons.push('offers alternatives without choosing one');
  return { ambiguous: reasons.length > 0, reasons };
}

export function ambiguityNote(assessment) {
  return `The request ${assessment.reasons.join(' and ')}. Before changing anything, work out what is meant from the repository and any context you have; if it is still genuinely unclear which of several things is wanted, ask one short clarifying question with user_ask instead of guessing.`;
}
