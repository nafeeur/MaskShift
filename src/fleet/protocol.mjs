// The wire format agents in a fleet use to talk to each other.
//
// Every harness MaskShift can drive (Claude Code, Codex, OpenCode, Hermes, Aider, a custom CLI, or MaskShift's
// own engine) is reachable only as text in, text out. So the one channel they all share is the text itself:
// a member addresses a teammate by writing a directive block into its reply, and the fleet routes it.
//
//   [[send to=reviewer]] Please review src/auth.mjs for race conditions. [[/send]]
//   [[send to=*]] Heads up: I changed the config schema. [[/send]]
//   [[done]] Shipped: auth fixed, reviewed, tests green. [[/done]]
//
// Directives are parsed leniently (case-insensitive, quotes optional, several recipients allowed) because the
// writers are language models; the text outside them is the member's ordinary reply.

const SEND = /\[\[\s*send\s+(?:to\s*=\s*)?["']?([^\]"'\s][^\]"']*?)["']?\s*\]\]([\s\S]*?)\[\[\s*\/\s*send\s*\]\]/gi;
const DONE = /\[\[\s*done\s*\]\]([\s\S]*?)\[\[\s*\/\s*done\s*\]\]/gi;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

export function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Pull `send` and `done` directives out of a reply. `text` is what remains once they are removed. */
export function parseDirectives(raw) {
  const source = stripAnsi(raw);
  const sends = [];
  const dones = [];
  let text = source.replace(SEND, (_match, recipients, body) => {
    const message = body.trim();
    if (!message) return '';
    for (const to of String(recipients).split(/[,\s]+/).map((item) => item.replace(/^@/, '').trim()).filter(Boolean)) {
      sends.push({ to: to === 'all' || to === 'everyone' ? '*' : to, body: message });
    }
    return '';
  });
  text = text.replace(DONE, (_match, body) => { dones.push(body.trim()); return ''; });
  return { sends, done: dones.length ? dones.join('\n\n') || 'Done.' : null, text: text.replace(/\n{3,}/g, '\n\n').trim() };
}

export const PROTOCOL = [
  'You are one member of a team of AI coding agents working together, coordinated by MaskShift.',
  'To message a teammate, put this in your reply (it is routed to them; they answer by message):',
  '  [[send to=NAME]] your message [[/send]]      (to=* reaches everyone)',
  'When the overall task is complete, say so with:',
  '  [[done]] a short summary of the outcome [[/done]]',
  'Anything outside those blocks is your own working notes/answer. Be specific in messages: say what you need,',
  'which files are involved, and what you already tried. Do not message a teammate unless you need something from them.',
].join('\n');

const clip = (text, limit) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value;
};

/**
 * The prompt for one turn. The CLIs are stateless between invocations, so continuity is carried here: who you are,
 * who else is on the team, what you said and did recently, then whatever has just arrived for you.
 */
export function buildBriefing({ member, roster, objective = '', inbox = [], history = [], message = '', limits = {} }) {
  const historyChars = limits.historyChars ?? 6000;
  const messageChars = limits.messageChars ?? 12000;
  const lines = [PROTOCOL, ''];
  lines.push(`You are "${member.name}" (${member.title || member.harness}).`);
  if (member.role) lines.push(`Your role: ${member.role}`);
  const teammates = roster.filter((other) => other.id !== member.id);
  lines.push(teammates.length
    ? `Teammates:\n${teammates.map((other) => `- ${other.name} (${other.title || other.harness})${other.role ? `: ${other.role}` : ''}`).join('\n')}`
    : 'You have no teammates right now; work alone and finish the task.');
  if (objective) lines.push('', `Team objective:\n${clip(objective, 4000)}`);
  if (history.length) {
    const recent = [];
    let used = 0;
    for (const turn of [...history].reverse()) {
      const entry = `[${turn.at?.slice(11, 19) || ''}] you replied: ${turn.reply || '(no output)'}`;
      if (used + entry.length > historyChars && recent.length) break;
      recent.unshift(clip(entry, Math.max(400, historyChars - used)));
      used += entry.length;
    }
    lines.push('', 'Your recent turns (oldest first):', ...recent);
  }
  if (inbox.length) {
    lines.push('', 'Messages for you:');
    for (const item of inbox) lines.push(`--- from ${item.from}${item.kind === 'reply' ? ' (reply to you)' : ''} ---`, clip(item.body, messageChars));
  }
  if (message) lines.push('', inbox.length ? 'Also:' : 'Your task:', clip(message, messageChars));
  return lines.join('\n');
}
