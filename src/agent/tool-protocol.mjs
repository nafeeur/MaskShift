// Text tool-call protocol.
//
// Models without native function calling still follow instructions, so this module teaches
// them a tagged text format, parses their replies back into the same tool-call shape the
// native providers produce, and rewrites conversation history into plain chat turns. The
// agent engine and every capability above it stay unchanged: they only ever see toolCalls.
//
// Parsing is deliberately liberal. Small models mangle their own output constantly, so the
// reader accepts the common variants and repairs the usual JSON damage rather than failing
// a whole turn over a trailing comma.

import { truncate } from '../core/utils.mjs';

export const TOOL_CALL_TAG = 'tool_call';
export const TOOL_RESPONSE_TAG = 'tool_response';

// `<tool_call>` is the format Hermes, Qwen, and most instruct fine-tunes already emit, so
// asking for it plays to what the weights know instead of inventing a private convention.
const OPEN_TAGS = ['tool_call', 'function_call', 'tool-call', 'toolcall', 'invoke', 'tool_use'];
const NAME_KEYS = ['name', 'tool', 'tool_name', 'function', 'function_name', 'recipient_name'];
const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input', 'tool_input', 'kwargs'];

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json|tool_call|js|javascript)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// Small models emit Python literals, single quotes, bare keys, and trailing commas. Repair
// the damage that is unambiguous and leave anything genuinely ambiguous to fail loudly.
function repairJson(text) {
  let value = stripCodeFences(text);
  // Quote bare keys: {path: "x"} -> {"path": "x"}
  value = value.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
  // Single-quoted strings -> double-quoted, preserving embedded double quotes.
  value = value.replace(/'((?:[^'\\]|\\.)*)'/g, (match, inner) => `"${inner.replace(/"/g, '\\"')}"`);
  // Python and JS literals.
  value = value.replace(/\b(True|False|None|undefined|NaN)\b/g, (match) => (
    { True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null' }[match]
  ));
  // Trailing commas before a close.
  value = value.replace(/,(\s*[}\]])/g, '$1');
  return value;
}

function parseJsonLoose(text) {
  const direct = String(text || '').trim();
  if (!direct) return null;
  for (const candidate of [direct, repairJson(direct)]) {
    try { return JSON.parse(candidate); } catch { /* try the next repair */ }
  }
  return null;
}

// Scan for the first balanced {...} so trailing prose ("...} Let me know!") does not break
// the parse, and so a truncated tag still yields its object when the braces close.
function firstJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function pick(object, keys) {
  for (const key of keys) {
    if (object && Object.hasOwn(object, key) && object[key] !== null && object[key] !== undefined) {
      return { key, value: object[key] };
    }
  }
  return null;
}

// Turn one decoded payload into a tool call, tolerating the arrangements models produce:
// arguments as an object, arguments as a JSON string, or arguments inlined beside the name.
function toCall(payload, index, fallbackName = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const named = pick(payload, NAME_KEYS);
  const name = String(named?.value ?? fallbackName ?? '').trim();
  if (!name) return null;

  const argEntry = pick(payload, ARG_KEYS);
  let args = argEntry?.value;
  if (typeof args === 'string') args = parseJsonLoose(args) ?? { _raw: args };
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    // No recognisable argument container: treat every remaining key as an argument, which is
    // how a lot of small models flatten calls ({"name":"fs_read","path":"a.js"}).
    const rest = { ...payload };
    for (const key of [...NAME_KEYS, ...ARG_KEYS]) delete rest[key];
    args = Object.keys(rest).length ? rest : {};
  }
  return { id: `txt_${Date.now()}_${index}`, name, args };
}

function tagPattern() {
  const alternatives = OPEN_TAGS.join('|');
  // Matches <tool_call ...>body</tool_call> and an unterminated trailing <tool_call>body.
  return new RegExp(`<\\s*(${alternatives})([^>]*)>([\\s\\S]*?)(?:<\\s*/\\s*\\1\\s*>|$)`, 'gi');
}

function fencePattern() {
  return /```(?:tool_call|tool|function_call)\s*([\s\S]*?)(?:```|$)/gi;
}

function nameFromAttributes(attributes) {
  const match = String(attributes || '').match(/name\s*=\s*["']?([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * Extract tool calls from model prose.
 *
 * @returns {{content: string, toolCalls: object[], parseErrors: string[]}}
 *   `content` is the reply with tool-call blocks removed, so a salvaged call never leaks
 *   its own syntax into the user-visible answer.
 */
export function parseToolCalls(rawContent) {
  const original = String(rawContent || '');
  const toolCalls = [];
  const parseErrors = [];
  let index = 0;
  let content = original;

  const consume = (pattern, bodyOf, nameOf) => {
    content = content.replace(pattern, (match, ...groups) => {
      const body = bodyOf(groups);
      const fallbackName = nameOf ? nameOf(groups) : null;
      const decoded = parseJsonLoose(body) ?? parseJsonLoose(firstJsonObject(body) || '');
      const call = toCall(decoded, index, fallbackName);
      if (call) {
        index += 1;
        toolCalls.push(call);
      } else if (fallbackName) {
        // The tag named a tool but its body was unusable; a no-argument call is the better
        // reading, and the tool's own schema validation will report anything missing.
        index += 1;
        toolCalls.push({ id: `txt_${Date.now()}_${index}`, name: fallbackName, args: {} });
      } else {
        parseErrors.push(truncate(match.trim(), 400));
      }
      return '';
    });
  };

  consume(tagPattern(), (groups) => groups[2], (groups) => nameFromAttributes(groups[1]));
  consume(fencePattern(), (groups) => groups[0], () => null);

  // A reply that is nothing but a JSON call, with no tags at all.
  if (!toolCalls.length && !parseErrors.length) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const decoded = parseJsonLoose(trimmed);
      const named = decoded && pick(decoded, NAME_KEYS);
      // Require an argument container too, so ordinary JSON output is not mistaken for a call.
      if (named && pick(decoded, ARG_KEYS)) {
        const call = toCall(decoded, 0);
        if (call) { toolCalls.push(call); content = ''; }
      }
    }
  }

  return { content: content.replace(/\n{3,}/g, '\n\n').trim(), toolCalls, parseErrors };
}

export function renderToolCall(call) {
  return `<${TOOL_CALL_TAG}>\n${JSON.stringify({ name: call.name, arguments: call.args || {} })}\n</${TOOL_CALL_TAG}>`;
}

function renderSchema(tool) {
  const schema = tool.inputSchema || { type: 'object', properties: {} };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = Object.entries(schema.properties || {});
  if (!properties.length) return '    (no arguments)';
  return properties.map(([key, value]) => {
    const type = value?.type || (value?.oneOf ? 'string|object' : 'any');
    const flag = required.includes(key) ? 'required' : 'optional';
    const detail = value?.description ? ` — ${truncate(String(value.description), 160)}` : '';
    const choices = Array.isArray(value?.enum) ? ` (one of: ${value.enum.join(', ')})` : '';
    return `    - ${key} (${type}, ${flag})${choices}${detail}`;
  }).join('\n');
}

/**
 * The system-prompt section that teaches the format. Kept short and worked-example first:
 * small models copy a demonstrated shape far more reliably than they follow prose rules.
 */
export function renderToolInstructions(tools) {
  const catalog = tools.map((tool) => [
    `  ${tool.name}: ${truncate(tool.description || tool.title || '', 300)}`,
    renderSchema(tool),
  ].join('\n')).join('\n\n');

  return `
# Tool calling (text protocol)

This model has no native tool API, so tools are called by writing a block in your reply.
To call a tool, emit exactly:

<${TOOL_CALL_TAG}>
{"name": "TOOL_NAME", "arguments": {"argument": "value"}}
</${TOOL_CALL_TAG}>

Rules:
- The block must contain one JSON object with a "name" string and an "arguments" object.
- Emit one block per call. To run several independent tools in one turn, emit several blocks.
- Write nothing after the final block; stop and wait. Results arrive as <${TOOL_RESPONSE_TAG}> messages in the next turn.
- Never describe a call in prose or invent a tool. Only the tools listed below exist right now.
- When the task is finished and no more tools are needed, reply normally with no <${TOOL_CALL_TAG}> block. That plain reply ends the run, so never end a turn with a bare promise to act.

Worked example — reading a file, then answering:

<${TOOL_CALL_TAG}>
{"name": "fs_read", "arguments": {"path": "src/index.js"}}
</${TOOL_CALL_TAG}>

## Callable tools

${catalog || '  (none active — use capability_search and capability_activate to load some)'}
`.trim();
}

/**
 * Rewrite history into turns a non-tool model can consume: assistant tool calls become the
 * text the model is asked to produce, and results come back as user messages. Providers with
 * no tool support usually reject the `tool` role outright, so this is required, not cosmetic.
 */
export function toTextProtocolMessages(messages, tools = []) {
  const instructions = renderToolInstructions(tools);
  const converted = [];
  let systemSeen = false;

  for (const message of messages) {
    if (message.role === 'system') {
      systemSeen = true;
      const content = `${String(message.content || '')}\n\n${instructions}`;
      // Preserve Anthropic cache blocks; the instructions ride along as their own block.
      const blocks = Array.isArray(message.blocks) && message.blocks.length
        ? [...message.blocks, { text: instructions, cacheable: false }]
        : undefined;
      converted.push({ ...message, content, ...(blocks ? { blocks } : {}) });
      continue;
    }

    if (message.role === 'tool') {
      const label = message.toolName ? ` name="${message.toolName}"` : '';
      const status = message.isError ? ' status="error"' : '';
      const body = `<${TOOL_RESPONSE_TAG}${label}${status}>\n${String(message.content || '')}\n</${TOOL_RESPONSE_TAG}>`;
      const previous = converted.at(-1);
      // Merge consecutive results: many chat templates reject back-to-back user turns.
      if (previous?.role === 'user' && previous.__toolResponse) {
        previous.content = `${previous.content}\n${body}`;
      } else {
        converted.push({ role: 'user', content: body, __toolResponse: true });
      }
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const rendered = message.toolCalls.map(renderToolCall).join('\n');
      const text = [String(message.content || '').trim(), rendered].filter(Boolean).join('\n\n');
      converted.push({ role: 'assistant', content: text });
      continue;
    }

    converted.push({ role: message.role, content: String(message.content || '') });
  }

  if (!systemSeen) converted.unshift({ role: 'system', content: instructions });
  return converted.map(({ __toolResponse, ...message }) => message);
}

/** Correction sent back when a turn contained something call-shaped that would not parse. */
export function repairPrompt(parseErrors, tools = []) {
  const names = tools.map((tool) => tool.name).join(', ');
  return [
    `Your last reply contained ${parseErrors.length === 1 ? 'a tool call' : 'tool calls'} that could not be parsed:`,
    '',
    ...parseErrors.map((text) => `  ${text}`),
    '',
    `Re-send it in exactly this form, as strict JSON with double-quoted keys and no trailing commas:`,
    '',
    `<${TOOL_CALL_TAG}>`,
    `{"name": "TOOL_NAME", "arguments": {"argument": "value"}}`,
    `</${TOOL_CALL_TAG}>`,
    '',
    `Available tools: ${names || '(none)'}`,
    'If you do not need a tool, reply normally with no tool call block.',
  ].join('\n');
}
