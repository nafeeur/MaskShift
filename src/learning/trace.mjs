// Turning a run's recorded events into facts the learning code can use. Everything downstream (lessons, outcomes, skill
// mining, context feedback, the working-state summary) reads these facts rather than parsing events itself.

const READ_ONLY = /^(fs_(read|list|stat|read_binary)|search_|symbol_(read|outline)|git_(status|diff|log|show|checkpoint_list)|lsp_(hover|definition|references|symbols|diagnostics|discover|status)|code_graph|change_impact|context_plan|memory_(search|list)|skill_(search|load|read)|capability_|agent_persona|model_|plan_)/;

export const looksReadOnly = (name) => READ_ONLY.test(String(name || ''));

const PATH_KEYS = ['path', 'file', 'filePath', 'target'];

export function pathsOf(args = {}) {
  const found = [];
  for (const key of PATH_KEYS) if (typeof args[key] === 'string' && args[key]) found.push(args[key]);
  for (const key of ['paths', 'files', 'targets']) if (Array.isArray(args[key])) found.push(...args[key].filter((value) => typeof value === 'string'));
  for (const edit of Array.isArray(args.edits) ? args.edits : []) if (typeof edit?.path === 'string') found.push(edit.path);
  return [...new Set(found.map((value) => value.replace(/^\.\//, '')))];
}

/** A command reduced to what identifies it: `npm test --silent` → `npm test`. */
export function commandKey(command) {
  const words = String(command || '').trim().replace(/^(?:cd\s+\S+\s*&&\s*)/, '').split(/\s+/).filter((word) => !word.startsWith('-') || /^-(?:m|c)$/.test(word));
  const [first = '', second = '', third = ''] = words;
  if (/^(npm|pnpm|yarn|bun)$/.test(first)) return `${first} ${second === 'run' ? third : second}`.trim();
  if (/^(cargo|go|git|docker|kubectl|make|mvn|gradle|node|python3?|pytest|uv)$/.test(first)) return `${first} ${second}`.trim();
  return first;
}

export const isVerifyCommand = (command) => /^(npm|pnpm|yarn|bun) (run )?(test|build|lint|typecheck|check|verify)\b|^(pytest|python3? -m pytest|node --test|cargo (test|build|check|clippy)|go (test|build|vet)|make( test| check| build)?|mvn (test|verify|package)|gradle (test|build|check)|tsc\b|eslint\b|ruff\b|mypy\b)/.test(String(command || '').trim());

export function buildTrace(events = []) {
  const calls = [];
  const byId = new Map();
  const verifications = [];
  const counters = { repairs: 0, stagnationWarnings: 0, steered: 0, edits: 0, escalations: 0, errors: 0 };
  let step = 0;
  let stagnation = null;
  let stuck = null;
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === 'model-turn') step = payload.step || step + 1;
    else if (event.type === 'assistant') {
      for (const call of payload.toolCalls || []) {
        const record = { id: call.id, name: call.name, args: call.args || {}, step, ok: null, content: '' };
        calls.push(record);
        if (call.id) byId.set(call.id, record);
      }
    } else if (event.type === 'tool-result' || event.type === 'tool-error') {
      const record = byId.get(payload.toolCallId);
      if (record) { record.ok = event.type === 'tool-result'; record.content = String(payload.content || ''); }
      if (event.type === 'tool-error') counters.errors += 1;
    } else if (event.type === 'verification') verifications.push({ ok: payload.ok, attempt: payload.attempt, results: payload.results || [] });
    else if (event.type === 'tool-call-repair' || event.type === 'tool-call-repaired') counters.repairs += 1;
    else if (event.type === 'stagnation') { if (payload.level === 'stop') stagnation = payload; else counters.stagnationWarnings += 1; }
    else if (event.type === 'stuck' && payload.level === 'stop') stuck = payload;
    else if (event.type === 'steered') counters.steered += 1;
    else if (event.type === 'escalated') counters.escalations += 1;
  }
  const read = new Set();
  const edited = new Set();
  const commands = [];
  for (const call of calls) {
    const readOnly = looksReadOnly(call.name);
    for (const file of pathsOf(call.args)) (readOnly ? read : edited).add(file);
    if (!readOnly && pathsOf(call.args).length) counters.edits += 1;
    if (call.name === 'shell_exec' && call.args.command) commands.push({ command: String(call.args.command), key: commandKey(call.args.command), ok: call.ok, step: call.step });
  }
  return { calls, verifications, read, edited, commands, stagnation, stuck, counters, steps: step };
}

/** Times the run needed correcting: the harness nudged it, a call had to be repaired, verification failed, or the user steered. */
export function correctionsIn(trace) {
  return trace.counters.stagnationWarnings + trace.counters.repairs + trace.counters.steered + trace.verifications.filter((item) => !item.ok).length + (trace.stagnation ? 2 : 0);
}
