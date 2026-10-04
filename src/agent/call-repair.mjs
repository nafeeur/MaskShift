// Deterministic repair of tool calls that are *almost* right.
//
// A model that writes `read_file` instead of `fs_read`, `file_path` instead of `path`, or `"5"`
// where the schema wants `5` has not misunderstood the task — it has misremembered a spelling.
// Sending that back as an error costs a whole model turn (and re-bills the history). Resolving
// it in code costs nothing and a model that already gets it right never reaches any of this.
// Every repair is reported, so the harness can tell the model what it actually ran.

// Names models commonly reach for, mapped to MaskShift's own. An alias applies only when its
// target exists, so this never invents a capability.
const NAME_ALIASES = {
  read_file: 'fs_read', readfile: 'fs_read', cat: 'fs_read', view: 'fs_read', view_file: 'fs_read', open_file: 'fs_read', file_read: 'fs_read',
  write_file: 'fs_write', writefile: 'fs_write', create_file: 'fs_write', file_write: 'fs_write', save_file: 'fs_write',
  edit_file: 'fs_patch', edit: 'fs_patch', str_replace: 'fs_patch', str_replace_editor: 'fs_patch', replace_in_file: 'fs_patch', patch_file: 'fs_patch', file_edit: 'fs_patch', apply_edit: 'fs_patch', replace: 'fs_patch',
  apply_patch: 'fs_apply_patch', apply_diff: 'fs_apply_patch', git_apply: 'fs_apply_patch',
  list_files: 'fs_list', list_dir: 'fs_list', list_directory: 'fs_list', ls: 'fs_list', dir: 'fs_list', tree: 'fs_list', file_list: 'fs_list',
  bash: 'shell_exec', shell: 'shell_exec', sh: 'shell_exec', run_command: 'shell_exec', run_shell: 'shell_exec', execute: 'shell_exec', exec: 'shell_exec', terminal: 'shell_exec', run: 'shell_exec', command: 'shell_exec', execute_command: 'shell_exec', run_terminal_cmd: 'shell_exec', shell_command: 'shell_exec',
  grep: 'search_text', search: 'search_text', ripgrep: 'search_text', rg: 'search_text', find_in_files: 'search_text', text_search: 'search_text', search_code: 'search_text',
  find_files: 'search_files', glob: 'search_files', find_file: 'search_files', file_search: 'search_files',
  delete_file: 'fs_delete', remove_file: 'fs_delete', rm: 'fs_delete',
  move_file: 'fs_move', rename_file: 'fs_move', mv: 'fs_move',
  mkdir: 'fs_mkdir', make_directory: 'fs_mkdir', create_directory: 'fs_mkdir',
  diff: 'git_diff', status: 'git_status',
  update_plan: 'plan_update', todo: 'plan_update', todo_write: 'plan_update', todowrite: 'plan_update',
  web_search: 'web_search', fetch: 'web_fetch', fetch_url: 'web_fetch', http_get: 'web_fetch',
};

// Argument spellings, keyed by the canonical property they stand for. Matched only when the
// canonical name is a real property of the tool's schema.
const KEY_ALIASES = {
  path: ['file_path', 'filepath', 'filename', 'file_name', 'file', 'target', 'target_file', 'path_to_file', 'filePath', 'dir', 'directory', 'folder', 'directory_path', 'dir_path', 'location'],
  command: ['cmd', 'script', 'shell_command', 'bash_command', 'commandline', 'command_line', 'shell'],
  content: ['contents', 'text', 'body', 'file_text', 'file_content', 'data', 'new_content'],
  oldText: ['old_string', 'old_str', 'old_text', 'oldString', 'old', 'search', 'find', 'original', 'original_text', 'before', 'from_text', 'target_string'],
  newText: ['new_string', 'new_str', 'new_text', 'newString', 'new', 'replace', 'replacement', 'replace_with', 'after', 'to_text', 'updated_text'],
  query: ['pattern', 'regex', 'search', 'search_term', 'text', 'term', 'keyword', 'q', 'expression'],
  pattern: ['glob', 'query', 'name', 'file_pattern', 'filename_pattern'],
  maxEntries: ['limit', 'max_results', 'maxResults', 'max_entries'],
  timeoutMs: ['timeout', 'timeout_ms', 'timeoutMilliseconds'],
  cwd: ['working_directory', 'workdir', 'working_dir', 'cwd_path', 'run_in'],
  edits: ['changes', 'replacements', 'patches', 'modifications'],
};

const squash = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function editDistance(a, b, limit = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

/**
 * Resolves what a model wrote to a tool that exists. Returns `{ name, how }` on success (`how` is
 * null for an exact hit) or `{ name: null, suggestions }` so the error can say what was meant.
 */
export function resolveToolName(requested, available) {
  const names = [...available];
  const given = String(requested || '').trim();
  if (!given) return { name: null, suggestions: [] };
  const set = new Set(names);
  if (set.has(given)) return { name: given, how: null };
  // MCP tools carry a server prefix and must match exactly; guessing one could call the wrong server.
  if (given.startsWith('mcp__')) return { name: null, suggestions: names.filter((name) => name.startsWith('mcp__')).sort((x, y) => editDistance(x, given) - editDistance(y, given)).slice(0, 3) };

  const lowered = given.toLowerCase();
  const insensitive = names.filter((name) => name.toLowerCase() === lowered);
  if (insensitive.length === 1) return { name: insensitive[0], how: 'case' };

  const squashed = squash(given);
  const flattened = names.filter((name) => squash(name) === squashed);
  if (flattened.length === 1) return { name: flattened[0], how: 'spelling' };

  const alias = NAME_ALIASES[lowered] || NAME_ALIASES[squashed] || NAME_ALIASES[given];
  if (alias && set.has(alias)) return { name: alias, how: 'alias' };

  // A namespace the model made up around a real name ("functions.fs_read", "default_api:fs_read").
  const stripped = given.split(/[.:/]/).pop();
  if (stripped !== given && set.has(stripped)) return { name: stripped, how: 'namespace' };

  const limit = Math.max(1, Math.min(3, Math.floor(squashed.length / 5)));
  const scored = names.map((name) => ({ name, distance: editDistance(squash(name), squashed, limit) })).filter((entry) => entry.distance <= limit);
  scored.sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name));
  if (scored.length && (scored.length === 1 || scored[0].distance < scored[1].distance)) return { name: scored[0].name, how: 'typo' };

  const suggestions = names
    .map((name) => ({ name, score: name.includes(lowered) || lowered.includes(name) ? 0 : editDistance(squash(name), squashed) }))
    .sort((x, y) => x.score - y.score || x.name.localeCompare(y.name))
    .slice(0, 3)
    .map((entry) => entry.name);
  return { name: null, suggestions };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || !/^[[{]/.test(text)) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function typeOf(schema) {
  const type = schema?.type;
  if (Array.isArray(type)) return type.find((entry) => entry !== 'null') || null;
  return type || null;
}

function coerce(value, schema, repairs, where) {
  if (value === null || value === undefined) return value;
  const type = typeOf(schema);
  let next = value;
  const note = (kind, detail) => repairs.push({ kind, detail: `${where}: ${detail}` });

  if (type === 'integer' || type === 'number') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      next = Number(value);
      if (type === 'integer' && !Number.isInteger(next)) next = Math.round(next);
      note('coerce', `"${value}" → ${next}`);
    } else if (type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      next = Math.round(value);
      note('coerce', `${value} → ${next}`);
    } else if (typeof value === 'boolean') {
      next = value ? 1 : 0;
      note('coerce', `${value} → ${next}`);
    }
  } else if (type === 'boolean') {
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (['true', 'yes', 'y', '1', 'on'].includes(lowered)) { next = true; note('coerce', `"${value}" → true`); }
      else if (['false', 'no', 'n', '0', 'off', ''].includes(lowered)) { next = false; note('coerce', `"${value}" → false`); }
    } else if (typeof value === 'number' && (value === 0 || value === 1)) {
      next = value === 1;
      note('coerce', `${value} → ${next}`);
    }
  } else if (type === 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') {
      next = String(value);
      note('coerce', `${typeof value} → string`);
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      next = value.join(schema?.format === 'path' ? '/' : ' ');
      note('coerce', 'list of strings → one string');
    }
  } else if (type === 'array') {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) { next = parsed; note('coerce', 'JSON text → array'); }
    else if (!Array.isArray(value)) {
      const itemType = typeOf(schema.items);
      const wrappable = value && typeof value === 'object' ? itemType === 'object' || !itemType : typeof value === itemType || (itemType === 'string' && typeof value !== 'object');
      if (wrappable) { next = [typeof value === 'string' || typeof value === 'object' ? value : String(value)]; note('wrap', 'single value → one-element array'); }
    }
    if (Array.isArray(next) && schema.items) next = next.map((item, index) => coerceValue(item, schema.items, repairs, `${where}[${index}]`));
  } else if (type === 'object') {
    const parsed = parseMaybeJson(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { next = parsed; note('coerce', 'JSON text → object'); }
    if (next && typeof next === 'object' && !Array.isArray(next) && schema.properties) next = normalizeObject(next, schema, repairs, where);
  }

  if (Array.isArray(schema?.enum) && typeof next === 'string' && !schema.enum.includes(next)) {
    const match = schema.enum.find((option) => typeof option === 'string' && option.toLowerCase() === next.trim().toLowerCase());
    if (match !== undefined) { note('coerce', `"${next}" → "${match}"`); next = match; }
  }
  return next;
}

function coerceValue(value, schema, repairs, where) {
  return schema ? coerce(value, schema, repairs, where) : value;
}

function canonicalKey(key, known, bySquash) {
  const direct = bySquash.get(squash(key));
  if (direct) return direct;
  for (const [canonical, spellings] of Object.entries(KEY_ALIASES)) {
    if (known.has(canonical) && spellings.some((spelling) => spelling === key || squash(spelling) === squash(key))) return canonical;
  }
  return null;
}

function normalizeObject(input, schema, repairs, where = 'args') {
  const properties = schema?.properties || {};
  const known = new Set(Object.keys(properties));
  const out = {};
  const claimed = new Set();

  // Exact keys first, so a correct call is never second-guessed.
  for (const key of Object.keys(input)) if (known.has(key)) { out[key] = input[key]; claimed.add(key); }

  const bySquash = new Map([...known].map((key) => [squash(key), key]));
  for (const key of Object.keys(input)) {
    if (claimed.has(key)) continue;
    const target = canonicalKey(key, known, bySquash);
    if (target && !(target in out)) {
      out[target] = input[key];
      claimed.add(key);
      repairs.push({ kind: 'rename', detail: `${where}: \`${key}\` → \`${target}\`` });
    }
  }

  // Unrecognized keys are kept unless the schema forbids them: a tool may read more than it declares.
  for (const key of Object.keys(input)) {
    if (claimed.has(key)) continue;
    if (schema?.additionalProperties === false) { repairs.push({ kind: 'drop', detail: `${where}: dropped unknown \`${key}\`` }); continue; }
    out[key] = input[key];
  }

  for (const [key, value] of Object.entries(out)) {
    if (value === null || value === undefined) { delete out[key]; continue; }
    if (properties[key]) out[key] = coerce(value, properties[key], repairs, `${where}.${key}`);
  }
  return out;
}

// A model that flattens a one-element list: fs_patch({oldText, newText}) instead of {edits:[{…}]}.
// The flattened keys may themselves be misspelled (old_string/new_string), so they are matched
// against the item's properties with the same alias rules.
function hoistIntoArray(args, schema, repairs) {
  const properties = schema?.properties || {};
  for (const [key, property] of Object.entries(properties)) {
    if (typeOf(property) !== 'array' || key in args || !schema.required?.includes(key)) continue;
    const item = property.items;
    if (typeOf(item) !== 'object' || !item.properties) continue;
    const known = new Set(Object.keys(item.properties));
    const bySquash = new Map([...known].map((entry) => [squash(entry), entry]));
    const element = {};
    const used = [];
    for (const argKey of Object.keys(args)) {
      if (argKey in properties) continue;
      const target = known.has(argKey) ? argKey : canonicalKey(argKey, known, bySquash);
      if (target && !(target in element)) { element[target] = args[argKey]; used.push(argKey); }
    }
    if ((item.required || []).every((entry) => entry in element) && used.length) {
      for (const argKey of used) delete args[argKey];
      args[key] = [element];
      repairs.push({ kind: 'wrap', detail: `moved ${used.map((entry) => `\`${entry}\``).join(', ')} into \`${key}\`` });
    }
  }
}

/**
 * Brings a call's arguments in line with the tool's schema. Pure: never touches the filesystem and
 * never changes what a correct call means.
 */
export function normalizeArgs(rawArgs, schema) {
  const repairs = [];
  let args = rawArgs;
  if (typeof args === 'string') {
    const parsed = parseMaybeJson(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { args = parsed; repairs.push({ kind: 'coerce', detail: 'args: JSON text → object' }); }
    else {
      // A bare string stands for the tool's only required string argument.
      const required = schema?.required || [];
      if (required.length === 1 && typeOf(schema.properties?.[required[0]]) === 'string') {
        args = { [required[0]]: args };
        repairs.push({ kind: 'wrap', detail: `args: bare string → \`${required[0]}\`` });
      } else args = {};
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  if (!schema?.properties) return { args, repairs };
  const normalized = normalizeObject(args, schema, repairs);
  hoistIntoArray(normalized, schema, repairs);
  // hoisting may expose item objects that still need their own key/type repair
  if (Array.isArray(normalized.edits) || Object.values(schema.properties).some((property) => typeOf(property) === 'array')) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (Array.isArray(normalized[key]) && property.items && typeOf(property.items) === 'object') {
        normalized[key] = normalized[key].map((item, index) => (item && typeof item === 'object' && !Array.isArray(item)
          ? normalizeObject(item, property.items, repairs, `${key}[${index}]`)
          : item));
      }
    }
  }
  return { args: normalized, repairs };
}

export function missingRequired(args, schema) {
  const missing = [];
  for (const key of schema?.required || []) {
    const value = args?.[key];
    if (value === undefined || value === null) missing.push(key);
  }
  return missing;
}

/** `fs_patch(path: string, edits: array)` — one line a model can copy from. */
export function signature(name, schema) {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const parts = Object.entries(properties).slice(0, 8).map(([key, property]) => `${key}${required.has(key) ? '' : '?'}: ${typeOf(property) || 'any'}`);
  return `${name}(${parts.join(', ')})`;
}

export function missingArgumentMessage(name, schema, missing, given) {
  const received = Object.keys(given || {});
  return `${name} was called without required argument${missing.length === 1 ? '' : 's'} ${missing.map((key) => `\`${key}\``).join(', ')}`
    + `${received.length ? ` (received: ${received.map((key) => `\`${key}\``).join(', ')})` : ' (received no arguments)'}. Usage: ${signature(name, schema)}`;
}

export function unknownToolMessage(requested, suggestions) {
  return `Tool '${requested}' does not exist.${suggestions?.length ? ` Closest: ${suggestions.join(', ')}.` : ''} Use capability_search to find a tool for what you need.`;
}
