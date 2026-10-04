// Measuring a model instead of guessing from its name.
//
// Four short probes, each exercising something an agent loop depends on, scored 0–1 by checking
// the model's actual output — a valid tool call, an edit that applies and changes exactly one
// thing, a plan with the right shape, a fact retrieved from the middle of a long log. The whole
// run is a handful of calls (a few thousand tokens), so it is opt-in: nothing is spent on a model
// until someone asks for its profile, and the harness works from a prior until then.

import { createHash } from 'node:crypto';
import { normalizeArgs, resolveToolName } from './call-repair.mjs';
import { applyEdit, EditMatchError } from '../tools/edit-match.mjs';
import { compositeScore, levelFromScore } from './capability-profile.mjs';

const RECORD_TOOL = {
  name: 'record_value', description: 'Record one named value.',
  inputSchema: { type: 'object', required: ['key', 'count'], properties: { key: { type: 'string' }, count: { type: 'integer' } } },
};

const EDIT_TOOL = {
  name: 'fs_patch', description: 'Apply oldText/newText replacements to a file.',
  inputSchema: {
    type: 'object', required: ['path', 'edits'],
    properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', required: ['oldText', 'newText'], properties: { oldText: { type: 'string' }, newText: { type: 'string' } } } } },
  },
};

const EDIT_FILE = [
  'import { fetchJson } from "./http.js";',
  '',
  'const timeoutMs = 3000;',
  'const retries = 3;',
  '',
  'export async function load(url) {',
  '  for (let attempt = 0; attempt < retries; attempt += 1) {',
  '    try {',
  '      return await fetchJson(url, { timeoutMs });',
  '    } catch (error) {',
  '      if (attempt === retries - 1) throw error;',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const usageOf = (response) => ({
  input: Number(response?.usage?.input_tokens ?? response?.usage?.prompt_tokens ?? 0) || 0,
  output: Number(response?.usage?.output_tokens ?? response?.usage?.completion_tokens ?? 0) || 0,
});

function validRecord(call, key, count) {
  const resolved = resolveToolName(call?.name, ['record_value']);
  if (!resolved.name) return { score: 0, detail: `called unknown tool ${call?.name}` };
  const { args, repairs } = normalizeArgs(call.args, RECORD_TOOL.inputSchema);
  const right = args.key === key && Number(args.count) === count;
  if (!right) return { score: 0, detail: `wrong arguments ${JSON.stringify(call.args)}` };
  return { score: resolved.how || repairs.length ? 0.6 : 1, detail: resolved.how || repairs.length ? 'correct after repair' : 'exact' };
}

async function probeToolCalling(complete) {
  const single = await complete([{ role: 'user', content: "Call the record_value tool with key 'alpha' and count 3. Do nothing else." }], [RECORD_TOOL]);
  const first = single.toolCalls?.length ? validRecord(single.toolCalls[0], 'alpha', 3) : { score: 0, detail: 'made no tool call' };
  const double = await complete([{ role: 'user', content: "Call record_value twice in the same reply: once with key 'one' and count 1, once with key 'two' and count 2." }], [RECORD_TOOL]);
  const calls = double.toolCalls || [];
  const hits = [validRecord(calls.find((call) => call?.args?.key === 'one') || {}, 'one', 1), validRecord(calls.find((call) => call?.args?.key === 'two') || {}, 'two', 2)];
  const parallel = hits.reduce((total, hit) => total + (hit.score > 0 ? 0.5 : 0), 0);
  return { score: first.score * 0.6 + parallel * 0.4, detail: `single: ${first.detail}; parallel: ${calls.length} call(s)`, usage: [single, double] };
}

async function probeEditing(complete) {
  const response = await complete([{
    role: 'user',
    content: `This is the file src/load.js:\n\n${EDIT_FILE}\nChange the number of retries from 3 to 5. Use the fs_patch tool; change nothing else.`,
  }], [EDIT_TOOL]);
  const call = response.toolCalls?.[0];
  if (!call) return { score: 0, detail: 'made no tool call', usage: [response] };
  const resolved = resolveToolName(call.name, ['fs_patch']);
  if (!resolved.name) return { score: 0, detail: `called unknown tool ${call.name}`, usage: [response] };
  const { args, repairs } = normalizeArgs(call.args, EDIT_TOOL.inputSchema);
  // The harness repairs a misnamed tool or argument for free, but a model that gets them right
  // needs less of that help, so it scores higher.
  const sloppy = Boolean(resolved.how) || repairs.length > 0;
  let content = EDIT_FILE;
  let loose = false;
  try {
    for (const edit of args.edits || []) {
      const result = applyEdit(content, edit.oldText, edit.newText ?? '');
      if (result.strategy !== 'exact') loose = true;
      content = result.content;
    }
  } catch (error) {
    return { score: 0, detail: error instanceof EditMatchError ? `edit did not apply (${error.kind})` : error.message, usage: [response] };
  }
  const expected = EDIT_FILE.replace('const retries = 3;', 'const retries = 5;');
  if (content !== expected) return { score: 0.2, detail: 'applied, but changed more or less than asked', usage: [response] };
  const score = Math.min(loose ? 0.7 : 1, sloppy ? 0.8 : 1);
  return { score, detail: loose ? 'correct, needed a looser match' : (sloppy ? 'correct after repair' : 'exact'), usage: [response] };
}

async function probePlanning(complete) {
  const response = await complete([{
    role: 'user',
    content: 'A function named getUser must be renamed to fetchUser everywhere in a repository of about 40 files. Reply with ONLY a numbered list of 3 to 6 short steps, each starting with a verb. No other text.',
  }], []);
  const text = String(response.content || '');
  const steps = text.split('\n').map((line) => line.trim()).filter((line) => /^\d+[.)]\s+\S/.test(line));
  const extraProse = text.split('\n').filter((line) => line.trim() && !/^\d+[.)]\s/.test(line.trim())).length;
  let score = 0;
  if (steps.length >= 3 && steps.length <= 6) score += 0.5; else if (steps.length) score += 0.2;
  const covered = [/\b(find|search|locate|grep|list|identify)\b/i, /\b(rename|replace|update|change|edit)\b/i, /\b(test|verify|run|check|build)\b/i].filter((pattern) => pattern.test(text)).length;
  score += (covered / 3) * 0.35;
  if (extraProse === 0) score += 0.15;
  return { score: Math.min(1, score), detail: `${steps.length} steps, ${covered}/3 phases, ${extraProse} stray lines`, usage: [response] };
}

async function probeLongContext(complete, { ref, windowTokens }) {
  const token = `ZK-${createHash('sha256').update(String(ref)).digest('hex').slice(0, 4).toUpperCase()}`;
  const targetTokens = Math.max(800, Math.min(6000, Math.floor((windowTokens || 8192) * 0.3)));
  const lineCount = Math.ceil((targetTokens * 4) / 58);
  const needleAt = Math.floor(lineCount * 0.55);
  const rows = Array.from({ length: lineCount }, (_, index) => (index === needleAt
    ? `[2026-03-01T10:${String(index % 60).padStart(2, '0')}:07] release-token=${token}`
    : `[2026-03-01T10:${String(index % 60).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}] worker-${index % 9} heartbeat ok latency=${(index * 13) % 90}ms`));
  const response = await complete([{ role: 'user', content: `${rows.join('\n')}\n\nWhat is the value of release-token in the log above? Reply with only the value.` }], []);
  const answer = String(response.content || '');
  const found = answer.includes(token);
  return { score: found ? 1 : 0, detail: found ? `found in ~${targetTokens} tokens` : `missed in ~${targetTokens} tokens`, usage: [response] };
}

const PROBES = [
  ['toolCalling', probeToolCalling],
  ['editing', probeEditing],
  ['planning', probePlanning],
  ['longContext', probeLongContext],
];

/**
 * Runs the probes against one model and returns a profile ready to store. A probe that errors
 * scores 0 with the reason; if the very first call cannot reach the model at all the error is
 * thrown, since a profile of an unreachable model would be worse than none.
 */
export async function calibrateModel({ providerManager, modelRef, signal, only = null, onProbe = null }) {
  const profile = await providerManager.modelProfile(modelRef);
  const complete = (messages, tools) => providerManager.complete({ modelRef, messages, tools, signal, temperature: 0, maxTokens: Math.min(1024, profile.maxOutputTokens || 1024) });
  const scores = {};
  const probes = [];
  const tokens = { input: 0, output: 0 };
  for (const [name, run] of PROBES) {
    if (only && !only.includes(name)) continue;
    const started = Date.now();
    let outcome;
    try {
      outcome = await run(complete, { ref: profile.ref, windowTokens: profile.contextWindow });
    } catch (error) {
      if (!probes.length && !signal?.aborted && /ECONNREFUSED|fetch failed|ENOTFOUND|401|403|404/.test(String(error.message))) throw error;
      if (signal?.aborted) throw error;
      outcome = { score: 0, detail: `error: ${String(error.message).slice(0, 160)}`, usage: [] };
    }
    for (const response of outcome.usage || []) {
      const used = usageOf(response);
      tokens.input += used.input;
      tokens.output += used.output;
    }
    scores[name] = Math.round(outcome.score * 100) / 100;
    const entry = { name, score: scores[name], detail: outcome.detail, ms: Date.now() - started };
    probes.push(entry);
    onProbe?.(entry);
  }
  const composite = compositeScore(scores);
  return {
    version: 1, ref: profile.ref, at: new Date().toISOString(), scores,
    composite: composite === null ? null : Math.round(composite * 100) / 100,
    level: composite === null ? null : levelFromScore(composite),
    contextWindow: profile.contextWindow, probes, tokens,
  };
}
