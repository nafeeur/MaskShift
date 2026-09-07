import { safeJsonParse, truncate } from '../core/utils.mjs';
import { parseToolCalls, toTextProtocolMessages } from './tool-protocol.mjs';

// Errors a provider returns when the model or endpoint has no function-calling support.
// Matching these is what lets `toolProtocol: 'auto'` recover without the user configuring it.
const NO_TOOL_SUPPORT = /(does not support tools|tools are not supported|tool use is not supported|unsupported.{0,20}tool|no endpoints found that support tool use|function calling is not|tool_choice.{0,30}not supported|does not support function)/i;

function looksLikeMissingToolSupport(error) {
  const text = `${error?.message || ''} ${JSON.stringify(error?.data || {})}`;
  return NO_TOOL_SUPPORT.test(text);
}

function splitModelRef(ref) {
  const value = String(ref || '');
  const index = value.indexOf(':');
  return index < 0 ? { providerId: null, model: value } : { providerId: value.slice(0, index), model: value.slice(index + 1) };
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error(`Provider request timed out after ${timeoutMs} ms`)), timeoutMs) : null;
  timer?.unref();
  const abort = () => controller.abort(signal.reason || new Error('Aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

// Statuses worth a second attempt. 4xx that mean "your request is wrong" (400, 401, 403,
// 404, 422) are excluded deliberately: retrying them burns time and never succeeds, and the
// tool-protocol downgrade in #complete depends on a 400 surfacing immediately.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY = { attempts: 3, baseMs: 500, maxMs: 30_000 };

function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// Full jitter over the top half of the window: enough spread to break up a thundering herd
// without ever collapsing the wait to nearly zero.
function backoffMs(attempt, settings, suggestedMs) {
  if (Number.isFinite(suggestedMs)) return Math.min(suggestedMs, settings.maxMs);
  const ceiling = Math.min(settings.maxMs, settings.baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

// Not unref'd: a run waiting out a backoff is real work, and the process must not exit under it.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Aborted')); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJson(url, options, { signal, timeoutMs = 180_000, retry = null, onRetry = null } = {}) {
  const settings = { ...DEFAULT_RETRY, ...(retry || {}) };
  // Callers opt in. Probes (model listings, health checks) keep single-shot behaviour.
  const attempts = retry ? Math.max(1, Number(settings.attempts) || 1) : 1;

  for (let attempt = 1; ; attempt += 1) {
    const combined = combineSignals(signal, timeoutMs);
    let response = null;
    let text = '';
    let transportError = null;
    try {
      response = await fetch(url, { ...options, signal: combined.signal });
      text = await response.text();
    } catch (error) {
      transportError = error;
    } finally {
      combined.cleanup();
    }

    // The run was cancelled. Surface that, never retry into it.
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Model request aborted');

    if (transportError) {
      const error = new Error(`Model request failed: ${transportError.message}`);
      if (attempt >= attempts) throw error;
      const waitMs = backoffMs(attempt, settings, null);
      onRetry?.({ attempt, attempts, waitMs, reason: error.message, status: null });
      await sleep(waitMs, signal);
      continue;
    }

    const data = safeJsonParse(text, null);
    if (!response.ok) {
      const message = data?.error?.message || data?.message || truncate(text, 4000) || `HTTP ${response.status}`;
      const error = new Error(`${response.status} ${response.statusText}: ${message}`);
      error.status = response.status;
      error.data = data;
      if (attempt >= attempts || !RETRY_STATUS.has(response.status)) throw error;
      const waitMs = backoffMs(attempt, settings, retryAfterMs(response));
      onRetry?.({ attempt, attempts, waitMs, reason: truncate(error.message, 300), status: response.status });
      await sleep(waitMs, signal);
      continue;
    }
    if (!data) throw new Error(`Provider returned invalid JSON: ${truncate(text, 2000)}`);
    return data;
  }
}

// ------------------------------------------------------------------- streaming
//
// Providers stream over SSE (OpenAI, Anthropic, Gemini) or newline-delimited JSON (Ollama).
// Both framings are a few lines over the fetch body, so streaming costs no dependency.

async function* decodedChunks(body, touch) {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    touch?.();
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function* sseData(body, touch) {
  let buffer = '';
  for await (const text of decodedChunks(body, touch)) {
    buffer += text.replaceAll('\r\n', '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      // Per the SSE spec a frame may carry several data: lines; providers send one JSON
      // object, but joining keeps a pretty-printed payload intact.
      const data = frame.split('\n').filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim()).join('\n');
      if (data && data !== '[DONE]') yield data;
    }
  }
}

async function* ndjsonData(body, touch) {
  let buffer = '';
  for await (const text of decodedChunks(body, touch)) {
    buffer += text.replaceAll('\r\n', '\n');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

// Open a streaming request. Unlike fetchJson the timeout is an *idle* watchdog reset on every
// chunk, not a total budget: a long generation is normal, a silent socket is not. Retrying is
// only sound before the first token has been handed to the caller, so this retries while
// establishing the response and hands the body over untouched once headers are good.
async function openStream(url, options, { signal, timeoutMs = 300_000, retry = null, onRetry = null } = {}) {
  const settings = { ...DEFAULT_RETRY, ...(retry || {}) };
  const attempts = retry ? Math.max(1, Number(settings.attempts) || 1) : 1;

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason || new Error('Aborted'));
    signal?.addEventListener('abort', forward, { once: true });
    let timer = null;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`Provider stream stalled for ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
    };
    const release = () => { clearTimeout(timer); signal?.removeEventListener('abort', forward); };
    touch();

    let response = null;
    let transportError = null;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) { transportError = error; }

    if (signal?.aborted) {
      release();
      throw signal.reason instanceof Error ? signal.reason : new Error('Model request aborted');
    }
    if (!transportError && response.ok && response.body) {
      // Not every endpoint honours `stream: true` — proxies and older local servers answer
      // with one plain JSON body. Reading that as a stream finds zero frames and silently
      // yields an empty turn, so detect it and hand the body back for the unary parser.
      const contentType = response.headers.get('content-type') || '';
      if (!/event-stream|ndjson|jsonl/i.test(contentType)) {
        const text = await response.text().catch(() => '');
        release();
        const data = safeJsonParse(text, null);
        if (!data) throw new Error(`Provider ignored the streaming request and returned a non-JSON body: ${truncate(text, 2000)}`);
        return { unary: data, release: () => {} };
      }
      return { response, touch, release };
    }

    let error;
    if (transportError) {
      error = new Error(`Model request failed: ${transportError.message}`);
    } else if (!response.body) {
      release();
      throw new Error(`Provider returned an empty stream (HTTP ${response.status})`);
    } else {
      const text = await response.text().catch(() => '');
      const data = safeJsonParse(text, null);
      const message = data?.error?.message || data?.message || truncate(text, 4000) || `HTTP ${response.status}`;
      error = new Error(`${response.status} ${response.statusText}: ${message}`);
      error.status = response.status;
      error.data = data;
    }
    const suggested = transportError ? null : retryAfterMs(response);
    release();

    const retryable = transportError ? true : RETRY_STATUS.has(error.status);
    if (attempt >= attempts || !retryable) throw error;
    const waitMs = backoffMs(attempt, settings, suggested);
    onRetry?.({ attempt, attempts, waitMs, reason: truncate(error.message, 300), status: error.status ?? null });
    await sleep(waitMs, signal);
  }
}

// Tool calls arrive as fragments keyed by index; concatenate then parse once at the end.
function assembleStreamedCalls(fragments) {
  return [...fragments.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], position) => normalizeToolCall({ id: call.id, name: call.name, arguments: call.args || '{}' }, position))
    .filter((call) => call.name);
}

// Unary response parsers. Shared by the non-streaming path and by the streaming path when an
// endpoint ignores `stream: true`, so one provider quirk is only ever described in one place.
function parseOpenAiBody(data) {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : (message.content || []).map((item) => item.text || '').join(''),
    toolCalls: (message.tool_calls || []).map(normalizeToolCall).filter((call) => call.name),
    finishReason: choice.finish_reason || null,
    usage: data.usage || null,
  };
}

function parseResponsesBody(data) {
  const output = data.output || [];
  const content = output.filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' || typeof item.text === 'string')
    .map((item) => item.text || '').join('\n');
  return {
    content: content || data.output_text || '',
    toolCalls: output.filter((item) => item.type === 'function_call').map((item, index) => normalizeToolCall({
      id: item.call_id || item.id, name: item.name, arguments: item.arguments,
    }, index)).filter((call) => call.name),
    finishReason: data.status || null,
    usage: data.usage || null,
    responseId: data.id || null,
  };
}

function parseOllamaBody(data) {
  const message = data.message || {};
  return {
    content: message.content || '',
    toolCalls: (message.tool_calls || []).map(normalizeToolCall).filter((call) => call.name),
    finishReason: data.done_reason || (data.done ? 'stop' : null),
    usage: {
      input_tokens: data.prompt_eval_count,
      output_tokens: data.eval_count,
      total_duration_ns: data.total_duration,
    },
  };
}

function parseAnthropicBody(data) {
  const blocks = data.content || [];
  return {
    content: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
    toolCalls: blocks.filter((block) => block.type === 'tool_use').map((block, index) => normalizeToolCall(block, index)),
    finishReason: data.stop_reason || null,
    usage: data.usage || null,
  };
}

function parseGeminiBody(data) {
  const candidate = data.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  return {
    content: parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('\n'),
    toolCalls: parts.filter((part) => part.functionCall).map((part, index) => normalizeToolCall(part, index)),
    finishReason: candidate.finishReason || null,
    usage: data.usageMetadata || null,
  };
}

async function readOpenAiStream(response, touch, onDelta) {
  let content = '';
  let finishReason = null;
  let usage = null;
  const fragments = new Map();
  for await (const data of sseData(response.body, touch)) {
    const chunk = safeJsonParse(data, null);
    if (!chunk) continue;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    const text = typeof delta.content === 'string' ? delta.content : (delta.content || []).map((part) => part.text || '').join('');
    if (text) { content += text; onDelta?.(text); }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? fragments.size;
      const entry = fragments.get(index) || { id: call.id, name: '', args: '' };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name += call.function.name;
      if (call.function?.arguments) entry.args += call.function.arguments;
      fragments.set(index, entry);
    }
  }
  return { content, toolCalls: assembleStreamedCalls(fragments), finishReason, usage };
}

async function readResponsesStream(response, touch, onDelta) {
  let content = '';
  let finishReason = null;
  let usage = null;
  let responseId = null;
  const fragments = new Map();
  for await (const data of sseData(response.body, touch)) {
    const event = safeJsonParse(data, null);
    if (!event) continue;
    const index = event.output_index ?? fragments.size;
    switch (event.type) {
      case 'response.output_text.delta':
        if (event.delta) { content += event.delta; onDelta?.(event.delta); }
        break;
      case 'response.output_item.added':
        if (event.item?.type === 'function_call') {
          fragments.set(index, { id: event.item.call_id || event.item.id, name: event.item.name || '', args: '' });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const entry = fragments.get(index) || { id: event.item_id, name: '', args: '' };
        entry.args += event.delta || '';
        fragments.set(index, entry);
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        responseId = event.response?.id || responseId;
        usage = event.response?.usage || usage;
        finishReason = event.response?.status || finishReason;
        break;
      default: break;
    }
  }
  return { content, toolCalls: assembleStreamedCalls(fragments), finishReason, usage, responseId };
}

async function readAnthropicStream(response, touch, onDelta) {
  let content = '';
  let finishReason = null;
  const usage = {};
  const fragments = new Map();
  for await (const data of sseData(response.body, touch)) {
    const event = safeJsonParse(data, null);
    if (!event) continue;
    if (event.type === 'message_start') Object.assign(usage, event.message?.usage || {});
    else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      fragments.set(event.index, { id: event.content_block.id, name: event.content_block.name || '', args: '' });
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        content += event.delta.text;
        onDelta?.(event.delta.text);
      } else if (event.delta?.type === 'input_json_delta') {
        const entry = fragments.get(event.index);
        if (entry) entry.args += event.delta.partial_json || '';
      }
    } else if (event.type === 'message_delta') {
      finishReason = event.delta?.stop_reason || finishReason;
      Object.assign(usage, event.usage || {});
    } else if (event.type === 'error') {
      throw new Error(event.error?.message || 'Anthropic stream error');
    }
  }
  return { content, toolCalls: assembleStreamedCalls(fragments), finishReason, usage };
}

async function readOllamaStream(response, touch, onDelta) {
  let content = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = [];
  for await (const line of ndjsonData(response.body, touch)) {
    const chunk = safeJsonParse(line, null);
    if (!chunk) continue;
    if (chunk.error) throw new Error(String(chunk.error));
    const text = chunk.message?.content || '';
    if (text) { content += text; onDelta?.(text); }
    for (const call of chunk.message?.tool_calls || []) {
      toolCalls.push(normalizeToolCall(call, toolCalls.length));
    }
    if (chunk.done) {
      finishReason = chunk.done_reason || 'stop';
      usage = { input_tokens: chunk.prompt_eval_count, output_tokens: chunk.eval_count, total_duration_ns: chunk.total_duration };
    }
  }
  return { content, toolCalls: toolCalls.filter((call) => call.name), finishReason, usage };
}

async function readGeminiStream(response, touch, onDelta) {
  let content = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = [];
  for await (const data of sseData(response.body, touch)) {
    const chunk = safeJsonParse(data, null);
    if (!chunk) continue;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === 'string' && part.text) { content += part.text; onDelta?.(part.text); }
      if (part.functionCall) toolCalls.push(normalizeToolCall(part, toolCalls.length));
    }
  }
  return { content, toolCalls: toolCalls.filter((call) => call.name), finishReason, usage };
}

function normalizeToolCall(call, index = 0) {
  const name = call?.function?.name || call?.name || call?.functionCall?.name;
  const rawArgs = call?.function?.arguments ?? call?.arguments ?? call?.functionCall?.args ?? call?.input ?? {};
  return {
    id: call.id || call.tool_call_id || `call_${Date.now()}_${index}`,
    name,
    args: typeof rawArgs === 'string' ? safeJsonParse(rawArgs, { _raw: rawArgs }) : (rawArgs || {}),
  };
}

function toOpenAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: String(message.content || '') };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        })),
      };
    }
    return { role: message.role, content: String(message.content || '') };
  });
}

function toOpenAiTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: truncate(tool.description || '', 1024),
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }));
}


function toResponsesInput(messages) {
  const instructions = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const input = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: String(message.content || '') });
      continue;
    }
    if (message.content) input.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content) });
    if (message.role === 'assistant') {
      for (const call of message.toolCalls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args || {}) });
      }
    }
  }
  return { instructions, input };
}

function toResponsesTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: truncate(tool.description || '', 1024),
    parameters: tool.inputSchema || { type: 'object', properties: {} },
    strict: false,
  }));
}

function anthropicSystemBlocks(messages) {
  const systemMessages = messages.filter((message) => message.role === 'system');
  if (systemMessages.length === 1 && Array.isArray(systemMessages[0].blocks) && systemMessages[0].blocks.length) {
    return systemMessages[0].blocks
      .filter((block) => block.text)
      .map((block) => (block.cacheable ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: block.text }));
  }
  const joined = systemMessages.map((message) => message.content).join('\n\n');
  return joined ? [{ type: 'text', text: joined }] : [];
}

function mergeAnthropicMessages(messages) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const converted = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls || []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args || {} });
      converted.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: String(message.content || ''), is_error: Boolean(message.isError) }],
      });
    } else {
      converted.push({ role: 'user', content: [{ type: 'text', text: String(message.content || '') }] });
    }
  }
  const merged = [];
  for (const message of converted) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) previous.content.push(...message.content);
    else merged.push(message);
  }
  return { system, messages: merged };
}

function toGemini(messages) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const contents = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: message.toolName || 'tool', response: { content: String(message.content || '') } } }] });
    } else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls || []) parts.push({ functionCall: { name: call.name, args: call.args || {} } });
      contents.push({ role: 'model', parts });
    } else contents.push({ role: 'user', parts: [{ text: String(message.content || '') }] });
  }
  return { system, contents };
}

export class ProviderManager {
  constructor({ config, logger, eventBus }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.modelCache = new Map();
  }

  provider(id) {
    const provider = this.config.get().providers.find((item) => item.id === id);
    if (!provider) throw new Error(`Unknown model provider: ${id}`);
    return provider;
  }

  apiKey(provider) {
    return provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
  }

  // Streaming is on unless the config or the individual provider opts out.
  streamingEnabled(provider) {
    if (provider.streaming === false) return false;
    return this.config.get().streaming !== false;
  }

  // Shared request options for every completion call: per-attempt timeout, retry policy, and
  // an event so a retried run is visible rather than looking like a stall.
  requestOptions(provider, { signal, timeoutMs }) {
    const settings = { ...DEFAULT_RETRY, ...(this.config.get().providerRetry || {}), ...(provider.retry || {}) };
    return {
      signal,
      timeoutMs: provider.timeoutMs || timeoutMs,
      retry: settings,
      onRetry: (info) => {
        this.logger.warn('Retrying model request', { provider: provider.id, ...info });
        this.eventBus.emit('model.request.retrying', { provider: provider.id, ...info });
      },
    };
  }

  isConfigured(provider) {
    if (!provider.enabled) return false;
    if (provider.type === 'ollama') return true;
    if (!provider.apiKeyEnv && !provider.apiKey) return true;
    return Boolean(this.apiKey(provider));
  }

  listProviders() {
    return this.config.get().providers.map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
      type: provider.type,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled !== false,
      configured: this.isConfigured(provider),
      apiKeyEnv: provider.apiKeyEnv || null,
      models: this.modelCache.get(provider.id)?.models || provider.models || [],
      status: this.modelCache.get(provider.id)?.status || 'unknown',
      error: this.modelCache.get(provider.id)?.error || null,
    }));
  }

  async discover(providerId, { force = false } = {}) {
    const provider = this.provider(providerId);
    const cached = this.modelCache.get(providerId);
    if (!force && cached && Date.now() - cached.at < 60_000) return cached;
    if (!this.isConfigured(provider)) {
      const result = { at: Date.now(), status: 'unconfigured', models: provider.models || [], error: null };
      this.modelCache.set(providerId, result);
      return result;
    }
    try {
      let models = provider.models || [];
      if (provider.type === 'ollama') {
        const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/api/tags`, { headers: provider.headers || {} }, { timeoutMs: 2500 });
        models = (data.models || []).map((item) => ({
          id: item.name || item.model,
          name: item.name || item.model,
          size: item.size,
          modifiedAt: item.modified_at,
          details: item.details || {},
        }));
      } else if (provider.type === 'openai-compatible' || provider.type === 'openai-responses') {
        const headers = { ...provider.headers };
        const key = this.apiKey(provider);
        if (key) headers.Authorization = `Bearer ${key}`;
        const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/models`, { headers }, { timeoutMs: 5000 });
        models = (data.data || data.models || []).map((item) => ({ id: item.id || item.name, name: item.id || item.name, ownedBy: item.owned_by }));
      } else if (provider.type === 'gemini') {
        const key = this.apiKey(provider);
        const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/models?key=${encodeURIComponent(key)}`, {}, { timeoutMs: 5000 });
        models = (data.models || []).filter((item) => item.supportedGenerationMethods?.includes('generateContent'))
          .map((item) => ({ id: item.name.replace(/^models\//, ''), name: item.displayName || item.name }));
      }
      const result = { at: Date.now(), status: 'online', models, error: null };
      this.modelCache.set(providerId, result);
      this.eventBus.emit('provider.status', { providerId, status: 'online', modelCount: models.length });
      return result;
    } catch (error) {
      const result = { at: Date.now(), status: 'offline', models: provider.models || [], error: error.message };
      this.modelCache.set(providerId, result);
      this.eventBus.emit('provider.status', { providerId, status: 'offline', error: error.message });
      return result;
    }
  }

  async discoverAll({ force = false } = {}) {
    const results = await Promise.all(this.config.get().providers.filter((provider) => provider.enabled !== false)
      .map((provider) => this.discover(provider.id, { force })));
    return this.listProviders();
  }

  chooseAutoModel(provider, models) {
    const ids = models.map((item) => typeof item === 'string' ? item : item.id).filter(Boolean);
    const preference = [
      /coder/i, /code/i, /qwen/i, /deepseek/i, /devstral/i, /codestral/i, /gpt/i, /claude/i, /gemini/i, /llama/i,
    ];
    for (const pattern of preference) {
      const matches = ids.filter((value) => pattern.test(value));
      if (matches.length) return matches.sort((a, b) => this.#sizeScore(b) - this.#sizeScore(a))[0];
    }
    return ids[0] || provider.defaultModel || null;
  }

  #sizeScore(name) {
    const matches = [...String(name).matchAll(/(\d+(?:\.\d+)?)\s*[bB]/g)];
    return matches.length ? Number(matches.at(-1)[1]) : 0;
  }

  async resolveModel(modelRef) {
    const requested = modelRef || this.config.get().defaultModel;
    let { providerId, model } = splitModelRef(requested);
    if (!providerId) {
      for (const provider of this.config.get().providers) {
        const discovered = await this.discover(provider.id);
        const match = discovered.models.find((item) => (item.id || item) === model);
        if (match) return { provider, model };
      }
      providerId = 'ollama';
    }
    const provider = this.provider(providerId);
    if (!this.isConfigured(provider)) throw new Error(`${provider.name || provider.id} is not configured. Set ${provider.apiKeyEnv || 'its API key'} or choose another model.`);
    if (!model || model === 'auto') {
      const discovered = await this.discover(providerId, { force: false });
      model = this.chooseAutoModel(provider, discovered.models);
    }
    if (!model) throw new Error(`No models are available from ${provider.name || provider.id}`);
    return { provider, model, ref: `${provider.id}:${model}` };
  }

  /** Cache of models proven to lack native tool calling, so the fallback costs one request once. */
  #textProtocolModels = new Set();

  toolProtocolFor(resolved) {
    const configured = resolved.provider.toolProtocol || 'auto';
    if (configured !== 'auto') return configured;
    return this.#textProtocolModels.has(resolved.ref) ? 'text' : 'native';
  }

  async #dispatch(resolved, messages, tools, options, protocol) {
    // In text mode the tools live in the prompt, so the wire request carries none. Providers
    // that reject a `tools` field, or silently drop it, both behave correctly this way.
    const useText = protocol === 'text' && tools.length > 0;
    const outbound = useText ? toTextProtocolMessages(messages, tools) : messages;
    const wireTools = useText ? [] : tools;
    const { signal, temperature, maxTokens } = options;
    // In text-protocol mode the tool calls live inside the prose and parseToolCalls rewrites
    // the content below, so streaming it would show the user call syntax that then vanishes.
    const onDelta = useText ? null : options.onDelta;

    let result;
    if (resolved.provider.type === 'anthropic') result = await this.#anthropic(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta });
    else if (resolved.provider.type === 'openai-responses') result = await this.#openAiResponses(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta });
    else if (resolved.provider.type === 'ollama') result = await this.#ollama(resolved, outbound, wireTools, { signal, temperature, onDelta });
    else if (resolved.provider.type === 'gemini') result = await this.#gemini(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta });
    else result = await this.#openAiCompatible(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta });

    result.toolProtocol = useText ? 'text' : 'native';
    result.parseErrors = [];
    if (useText) {
      const parsed = parseToolCalls(result.content);
      result.content = parsed.content;
      result.toolCalls = parsed.toolCalls;
      result.parseErrors = parsed.parseErrors;
    } else if (!result.toolCalls?.length && result.content && tools.length) {
      // Native mode salvage: a model that ignored the tool API but wrote the call as text
      // still gets its work done. Guarded on a real tool name so prose is never mistaken
      // for a call.
      const offered = new Set(tools.map((tool) => tool.name));
      const parsed = parseToolCalls(result.content);
      const recognised = parsed.toolCalls.filter((call) => offered.has(call.name));
      if (recognised.length) {
        result.content = parsed.content;
        result.toolCalls = recognised;
        result.toolProtocol = 'text-salvage';
        if (resolved.provider.toolProtocol !== 'native') this.#textProtocolModels.add(resolved.ref);
      } else if (parsed.parseErrors.length) {
        // The model tried to call a tool as text and mangled it. That is proof enough that its
        // native tool calling is not working, so switch protocols and let the engine ask for a
        // correction — the next turn then arrives with the format actually taught.
        result.parseErrors = parsed.parseErrors;
        if (resolved.provider.toolProtocol !== 'native') this.#textProtocolModels.add(resolved.ref);
      }
    }
    return result;
  }

  async complete({ modelRef, messages, tools = [], signal, temperature = 0.1, maxTokens = 16_384, onDelta = null }) {
    const resolved = await this.resolveModel(modelRef);
    const started = Date.now();
    const protocol = this.toolProtocolFor(resolved);
    this.eventBus.emit('model.request.started', { provider: resolved.provider.id, model: resolved.model, messages: messages.length, tools: tools.length, toolProtocol: protocol });
    try {
      let result;
      try {
        result = await this.#dispatch(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }, protocol);
      } catch (error) {
        // The endpoint rejected the tool schema outright: remember it and re-run in text mode
        // rather than surfacing a dead end to the user.
        const recoverable = protocol === 'native' && tools.length > 0
          && (resolved.provider.toolProtocol || 'auto') === 'auto'
          && looksLikeMissingToolSupport(error);
        if (!recoverable) throw error;
        this.#textProtocolModels.add(resolved.ref);
        this.eventBus.emit('model.tool-protocol.downgraded', {
          provider: resolved.provider.id, model: resolved.model, reason: truncate(error.message, 300),
        });
        result = await this.#dispatch(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }, 'text');
      }
      result.modelRef = resolved.ref;
      result.providerId = resolved.provider.id;
      result.providerType = resolved.provider.type;
      result.model = resolved.model;
      result.durationMs = Date.now() - started;
      result.streamed = Boolean(onDelta) && result.toolProtocol !== 'text';
      this.eventBus.emit('model.request.completed', {
        provider: resolved.provider.id, model: resolved.model, durationMs: result.durationMs,
        toolCalls: result.toolCalls.length, usage: result.usage, toolProtocol: result.toolProtocol,
        streamed: result.streamed,
      });
      return result;
    } catch (error) {
      this.eventBus.emit('model.request.failed', { provider: resolved.provider.id, model: resolved.model, durationMs: Date.now() - started, error: error.message });
      throw error;
    }
  }

  async #openAiResponses(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    const key = this.apiKey(provider);
    if (key) headers.Authorization = `Bearer ${key}`;
    const converted = toResponsesInput(messages);
    const body = {
      model: resolved.model,
      instructions: converted.instructions || undefined,
      input: converted.input,
      temperature,
      max_output_tokens: maxTokens,
      ...(tools.length ? { tools: toResponsesTools(tools), tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...provider.requestDefaults,
    };
    const url = `${provider.baseUrl.replace(/\/$/, '')}/responses`;
    const requestOptions = this.requestOptions(provider, { signal, timeoutMs: 300_000 });
    if (onDelta && this.streamingEnabled(provider)) {
      const stream = await openStream(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) }, requestOptions);
      try { return stream.unary ? parseResponsesBody(stream.unary) : await readResponsesStream(stream.response, stream.touch, onDelta); }
      finally { stream.release(); }
    }
    return parseResponsesBody(await fetchJson(url, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, requestOptions));
  }

  async #openAiCompatible(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    const key = this.apiKey(provider);
    if (key) headers.Authorization = `Bearer ${key}`;
    const body = {
      model: resolved.model,
      messages: toOpenAiMessages(messages),
      temperature,
      max_tokens: maxTokens,
      ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...provider.requestDefaults,
    };
    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const requestOptions = this.requestOptions(provider, { signal, timeoutMs: 300_000 });
    if (onDelta && this.streamingEnabled(provider)) {
      const streamBody = { ...body, stream: true, stream_options: { include_usage: true } };
      const stream = await openStream(url, { method: 'POST', headers, body: JSON.stringify(streamBody) }, requestOptions);
      try { return stream.unary ? parseOpenAiBody(stream.unary) : await readOpenAiStream(stream.response, stream.touch, onDelta); }
      finally { stream.release(); }
    }
    return parseOpenAiBody(await fetchJson(url, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, requestOptions));
  }

  async #ollama(resolved, messages, tools, { signal, temperature, onDelta }) {
    const provider = resolved.provider;
    const body = {
      model: resolved.model,
      messages: toOpenAiMessages(messages).map((message) => ({
        role: message.role,
        content: message.content || '',
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      })),
      stream: false,
      options: { temperature, ...(provider.options || {}) },
      ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
    };
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    const url = `${provider.baseUrl.replace(/\/$/, '')}/api/chat`;
    const requestOptions = this.requestOptions(provider, { signal, timeoutMs: 600_000 });
    if (onDelta && this.streamingEnabled(provider)) {
      const stream = await openStream(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) }, requestOptions);
      try { return stream.unary ? parseOllamaBody(stream.unary) : await readOllamaStream(stream.response, stream.touch, onDelta); }
      finally { stream.release(); }
    }
    return parseOllamaBody(await fetchJson(url, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, requestOptions));
  }

  async #anthropic(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const cachingEnabled = provider.promptCaching !== false;
    const converted = mergeAnthropicMessages(messages);

    // Mark the conversation-so-far boundary as cacheable: everything before the newest turn is
    // byte-identical to the previous request in this run, so Anthropic can reuse it from cache.
    if (cachingEnabled && converted.messages.length > 1) {
      const priorTurn = converted.messages[converted.messages.length - 2];
      const lastBlock = priorTurn?.content?.at?.(-1);
      if (lastBlock && typeof lastBlock === 'object') lastBlock.cache_control = { type: 'ephemeral' };
    }

    const toolDefs = tools.map((tool) => ({
      name: tool.name, description: truncate(tool.description || '', 1024), input_schema: tool.inputSchema || { type: 'object', properties: {} },
    }));
    if (cachingEnabled && toolDefs.length) toolDefs[toolDefs.length - 1].cache_control = { type: 'ephemeral' };

    const systemBlocks = cachingEnabled ? anthropicSystemBlocks(messages) : [];
    const body = {
      model: resolved.model,
      max_tokens: maxTokens,
      temperature,
      system: systemBlocks.length ? systemBlocks : converted.system,
      messages: converted.messages,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...provider.requestDefaults,
    };
    const url = `${provider.baseUrl.replace(/\/$/, '')}/messages`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey(provider),
      'anthropic-version': provider.anthropicVersion || '2023-06-01',
      ...provider.headers,
    };
    const requestOptions = this.requestOptions(provider, { signal, timeoutMs: 300_000 });
    if (onDelta && this.streamingEnabled(provider)) {
      const stream = await openStream(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) }, requestOptions);
      try { return stream.unary ? parseAnthropicBody(stream.unary) : await readAnthropicStream(stream.response, stream.touch, onDelta); }
      finally { stream.release(); }
    }
    return parseAnthropicBody(await fetchJson(url, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, requestOptions));
  }

  async #gemini(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const converted = toGemini(messages);
    const body = {
      contents: converted.contents,
      systemInstruction: converted.system ? { parts: [{ text: converted.system }] } : undefined,
      generationConfig: { temperature, maxOutputTokens: maxTokens },
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: truncate(tool.description || '', 1024),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      })) }] } : {}),
    };
    const base = `${provider.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(resolved.model)}`;
    const key = encodeURIComponent(this.apiKey(provider));
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    const requestOptions = this.requestOptions(provider, { signal, timeoutMs: 300_000 });
    if (onDelta && this.streamingEnabled(provider)) {
      const stream = await openStream(`${base}:streamGenerateContent?alt=sse&key=${key}`, { method: 'POST', headers, body: JSON.stringify(body) }, requestOptions);
      try { return stream.unary ? parseGeminiBody(stream.unary) : await readGeminiStream(stream.response, stream.touch, onDelta); }
      finally { stream.release(); }
    }
    return parseGeminiBody(await fetchJson(`${base}:generateContent?key=${key}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, requestOptions));
  }
}
