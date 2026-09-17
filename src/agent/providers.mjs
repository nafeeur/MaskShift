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

/** Reads a response body under a byte cap so a runaway/huge response cannot exhaust memory. */
async function readBounded(response, maxBytes) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw Object.assign(new Error(`Provider response exceeded ${maxBytes} bytes`), { code: 'HARNESS_RESPONSE_TOO_LARGE' });
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released on stream error */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Reads a `text/event-stream` body, calling `onFrame({ event, data })` for each frame as its
 * blank-line terminator arrives — `data` is the frame's raw payload text (its `data:` lines
 * joined), left unparsed here since some providers send a non-JSON sentinel (`[DONE]`).
 */
async function readSSE(response, maxBytes, onFrame) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  const emit = (frame) => {
    if (!frame.trim()) return;
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) onFrame({ event, data: dataLines.join('\n') });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw Object.assign(new Error(`Provider response exceeded ${maxBytes} bytes`), { code: 'HARNESS_RESPONSE_TOO_LARGE' });
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        emit(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    // Some servers close the connection without a trailing blank line after the last frame.
    emit(buffer);
  } finally {
    try { reader.releaseLock(); } catch { /* already released on stream error */ }
  }
}

/** Newline-delimited JSON (Ollama's streaming format) — one object per line, no `data:` framing. */
async function readNDJSON(response, maxBytes, onFrame) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw Object.assign(new Error(`Provider response exceeded ${maxBytes} bytes`), { code: 'HARNESS_RESPONSE_TOO_LARGE' });
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onFrame({ event: 'message', data: line });
      }
    }
    if (buffer.trim()) onFrame({ event: 'message', data: buffer });
  } finally {
    try { reader.releaseLock(); } catch { /* already released on stream error */ }
  }
}

/**
 * Streams a provider response frame-by-frame instead of buffering the whole body, so partial
 * text can reach the transcript as it's generated. Error responses are still read in full (they
 * are small, and providers send them as ordinary JSON, not as a stream) so the existing
 * status/message handling in `fetchJson` keeps working unchanged for the failure path.
 */
async function fetchStream(url, options, { signal, timeoutMs = 180_000, maxBytes = 32 * 1024 * 1024, onFrame, ndjson = false }) {
  const combined = combineSignals(signal, timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: combined.signal });
  } catch (error) {
    combined.cleanup();
    throw new Error(`Model request failed: ${error.message}`);
  }
  if (!response.ok) {
    let text;
    try { text = await readBounded(response, maxBytes); } finally { combined.cleanup(); }
    const data = safeJsonParse(text, null);
    const message = data?.error?.message || data?.message || truncate(text, 4000) || `HTTP ${response.status}`;
    const error = new Error(`${response.status} ${response.statusText}: ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  try {
    if (ndjson) await readNDJSON(response, maxBytes, onFrame);
    else await readSSE(response, maxBytes, onFrame);
  } catch (error) {
    if (error.code === 'HARNESS_RESPONSE_TOO_LARGE') throw error;
    throw new Error(`Model request failed: ${error.message}`);
  } finally {
    combined.cleanup();
  }
}

async function fetchJson(url, options, { signal, timeoutMs = 180_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  // The abort timer must stay armed through the body read, not just until headers arrive,
  // otherwise a stalled response body can hang the request indefinitely.
  const combined = combineSignals(signal, timeoutMs);
  let text, status, statusText, ok;
  try {
    const response = await fetch(url, { ...options, signal: combined.signal });
    ({ status, statusText, ok } = response);
    text = await readBounded(response, maxBytes);
  } catch (error) {
    if (error.code === 'HARNESS_RESPONSE_TOO_LARGE') throw error;
    throw new Error(`Model request failed: ${error.message}`);
  } finally {
    combined.cleanup();
  }
  const data = safeJsonParse(text, null);
  if (!ok) {
    const message = data?.error?.message || data?.message || truncate(text, 4000) || `HTTP ${status}`;
    const error = new Error(`${status} ${statusText}: ${message}`);
    error.status = status;
    error.data = data;
    throw error;
  }
  if (!data) throw new Error(`Provider returned invalid JSON: ${truncate(text, 2000)}`);
  return data;
}

function normalizeToolCall(call, index = 0) {
  const name = call?.function?.name || call?.name || call?.functionCall?.name;
  const rawArgs = call?.function?.arguments ?? call?.arguments ?? call?.functionCall?.args ?? call?.input ?? {};
  // The provider's own call id (when it has one) is preserved separately so it can be echoed
  // back verbatim on the next turn; providers without one (e.g. Gemini) fall back silently.
  const providerCallId = call.id || call.tool_call_id || call.functionCall?.id || null;
  return {
    id: providerCallId || `call_${Date.now()}_${index}`,
    name,
    args: typeof rawArgs === 'string' ? safeJsonParse(rawArgs, { _raw: rawArgs }) : (rawArgs || {}),
    ...(providerCallId ? { providerCallId } : {}),
  };
}

// Provider-specific state (reasoning traces, thinking blocks) is opaque and only meaningful
// when replayed back to the exact same model; a model switch mid-run must not resurface it.
function opaqueState(message, type, ref) {
  const value = message.providerState;
  return value?.type === type && value.ref === ref ? value : null;
}

function toOpenAiMessages(messages, ref = null) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: String(message.content || '') };
    }
    if (message.role === 'assistant') {
      const opaque = opaqueState(message, 'openai-compatible', ref);
      const value = { role: 'assistant', content: message.content || null };
      if (opaque?.reasoningContent !== undefined) value.reasoning_content = opaque.reasoningContent;
      if (message.toolCalls?.length) {
        value.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        }));
      }
      return value;
    }
    return { role: message.role, content: String(message.content || '') };
  });
}

// Ollama's chat API expects tool-call arguments as an object, unlike OpenAI's JSON-string form.
function toOllamaMessages(messages, ref = null) {
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_name: message.toolName || 'tool', content: String(message.content || '') };
    const value = { role: message.role, content: String(message.content || '') };
    if (message.role === 'assistant') {
      const opaque = opaqueState(message, 'ollama', ref);
      if (opaque?.thinking) value.thinking = opaque.thinking;
      if (message.toolCalls?.length) value.tool_calls = message.toolCalls.map((call, index) => ({ type: 'function', function: { index, name: call.name, arguments: call.args || {} } }));
    }
    return value;
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


function toResponsesInput(messages, ref = null) {
  const instructions = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const input = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: String(message.content || '') });
      continue;
    }
    const opaque = opaqueState(message, 'openai-responses', ref);
    // Encrypted reasoning items must be replayed verbatim, ahead of the visible turn content,
    // or the Responses API rejects the follow-up request.
    if (message.role === 'assistant' && opaque?.reasoning?.length) input.push(...structuredClone(opaque.reasoning));
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

function mergeAnthropicMessages(messages, ref = null) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const converted = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'assistant') {
      // Thinking blocks carry a signature Anthropic must see again verbatim; replaying the
      // original raw blocks (when this history was produced by the same model) preserves it.
      const opaque = opaqueState(message, 'anthropic', ref);
      const content = opaque?.blocks ? structuredClone(opaque.blocks) : [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.toolCalls || []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args || {} })),
      ];
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

function toGemini(messages, ref = null) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const contents = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: message.toolName || 'tool', response: { content: String(message.content || '') } } }] });
    } else if (message.role === 'assistant') {
      const opaque = opaqueState(message, 'gemini', ref);
      const parts = opaque?.parts ? structuredClone(opaque.parts) : [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls || []).map((call) => ({ functionCall: { name: call.name, args: call.args || {} } })),
      ];
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
        if (match) return { provider, model, ref: `${provider.id}:${model}` };
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

  /**
   * A model's declared context window, in tokens — from explicit per-model config
   * (`provider.models[].contextWindow`), a per-ref override (`config.harness.models[ref]`),
   * or Ollama's `num_ctx` option. Returns null when nothing is declared, so callers can leave
   * their existing (generous) default behavior untouched rather than guessing a model's limit
   * from its name.
   */
  async contextWindowFor(modelRef) {
    const resolved = await this.resolveModel(modelRef);
    const configured = (resolved.provider.models || []).find((item) => item?.id === resolved.model);
    const override = this.config.get().harness?.models?.[resolved.ref];
    const declared = Number(override?.contextWindow) || Number(configured?.contextWindow);
    if (Number.isFinite(declared) && declared >= 512) return Math.floor(declared);
    const numCtx = resolved.provider.type === 'ollama' ? Number(resolved.provider.options?.num_ctx) : null;
    if (Number.isFinite(numCtx) && numCtx >= 512) return Math.floor(numCtx);
    return null;
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
    const { signal, temperature, maxTokens, onDelta } = options;
    // A text-protocol reply carries the tool-call markup the model was asked to write inline
    // (parsed out below, after the full content is in) — streaming it to the transcript
    // un-stripped would show that markup to the operator, so only native-mode deltas forward.
    const forwardDelta = useText ? undefined : onDelta;

    let result;
    if (resolved.provider.type === 'anthropic') result = await this.#anthropic(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta: forwardDelta });
    else if (resolved.provider.type === 'openai-responses') result = await this.#openAiResponses(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta: forwardDelta });
    else if (resolved.provider.type === 'ollama') result = await this.#ollama(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta: forwardDelta });
    else if (resolved.provider.type === 'gemini') result = await this.#gemini(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta: forwardDelta });
    else result = await this.#openAiCompatible(resolved, outbound, wireTools, { signal, temperature, maxTokens, onDelta: forwardDelta });

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

  /**
   * `onDelta`, when given, is called with the assistant's visible text-so-far every time new
   * content arrives from the provider (cumulative, not just the new fragment, so a caller can
   * always just replace what it's showing rather than track its own running concatenation).
   * It is never called in text-tool-protocol mode — see the note in #dispatch — and a provider
   * that returns nothing until the response is complete will simply call it once, at the end,
   * which degrades to the old non-streaming behavior rather than breaking anything.
   */
  async complete({ modelRef, messages, tools = [], signal, temperature = 0.1, maxTokens = 16_384, onDelta } = {}) {
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
      this.eventBus.emit('model.request.completed', {
        provider: resolved.provider.id, model: resolved.model, durationMs: result.durationMs,
        toolCalls: result.toolCalls.length, usage: result.usage, toolProtocol: result.toolProtocol,
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
    const converted = toResponsesInput(messages, resolved.ref);
    const body = {
      model: resolved.model,
      instructions: converted.instructions || undefined,
      input: converted.input,
      temperature,
      max_output_tokens: maxTokens,
      include: ['reasoning.encrypted_content'],
      stream: true,
      ...(tools.length ? { tools: toResponsesTools(tools), tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...provider.requestDefaults,
    };
    // `response.completed` carries the full, structurally-authoritative response (reasoning
    // items, call ids, everything) — the same shape the non-streaming endpoint used to return —
    // so deltas are only used to feed the live transcript, never to build the final result.
    let deltaContent = '';
    let finalResponse = null;
    await fetchStream(`${provider.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, {
      signal, timeoutMs: provider.timeoutMs || 300_000,
      onFrame: ({ event, data }) => {
        const payload = safeJsonParse(data, null);
        if (!payload) return;
        if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
          deltaContent += payload.delta;
          onDelta?.(deltaContent);
        } else if (event === 'response.completed' || event === 'response.incomplete') {
          finalResponse = payload.response || payload;
        } else if (event === 'error' || event === 'response.failed') {
          throw Object.assign(new Error(payload.message || payload.error?.message || 'Model stream failed'), { data: payload });
        }
      },
    });
    const data = finalResponse || { output: [], output_text: deltaContent };
    const output = data.output || [];
    const content = output.filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === 'output_text' || typeof item.text === 'string')
      .map((item) => item.text || '').join('\n') || data.output_text || deltaContent;
    const toolCalls = output.filter((item) => item.type === 'function_call').map((item, index) => normalizeToolCall({
      id: item.call_id || item.id, name: item.name, arguments: item.arguments,
    }, index)).filter((call) => call.name);
    const reasoning = output.filter((item) => item.type === 'reasoning' && item.encrypted_content)
      .map((item) => ({ id: item.id, type: item.type, summary: item.summary || [], encrypted_content: item.encrypted_content }));
    return {
      content,
      toolCalls,
      finishReason: data.status || null,
      usage: data.usage || null,
      responseId: data.id || null,
      providerState: { type: 'openai-responses', ref: resolved.ref, reasoning },
    };
  }

  async #openAiCompatible(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    const key = this.apiKey(provider);
    if (key) headers.Authorization = `Bearer ${key}`;
    const body = {
      model: resolved.model,
      messages: toOpenAiMessages(messages, resolved.ref),
      temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...provider.requestDefaults,
    };
    let content = '';
    let reasoningContent = '';
    let finishReason = null;
    let usage = null;
    const toolCallsByIndex = new Map();
    await fetchStream(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, {
      signal, timeoutMs: provider.timeoutMs || 300_000,
      onFrame: ({ data }) => {
        if (data === '[DONE]') return;
        const chunk = safeJsonParse(data, null);
        if (!chunk) return;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onDelta?.(content);
        }
        if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
        // Each fragment of a tool call's name and JSON-string arguments arrives as its own tiny
        // chunk, keyed by the call's position in the response — accumulated here and only
        // exposed as complete calls once the stream ends, same as before.
        for (const call of delta.tool_calls || []) {
          const index = call.index ?? 0;
          const existing = toolCallsByIndex.get(index) || { id: '', name: '', args: '' };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) existing.args += call.function.arguments;
          toolCallsByIndex.set(index, existing);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      },
    });
    const toolCalls = [...toolCallsByIndex.values()]
      .map((call, index) => normalizeToolCall({ id: call.id, function: { name: call.name, arguments: call.args } }, index))
      .filter((call) => call.name);
    return {
      content, toolCalls, finishReason, usage,
      providerState: { type: 'openai-compatible', ref: resolved.ref, reasoningContent: reasoningContent || undefined },
    };
  }

  async #ollama(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const body = {
      model: resolved.model,
      messages: toOllamaMessages(messages, resolved.ref),
      stream: true,
      options: { temperature, ...(provider.options || {}), num_predict: maxTokens },
      ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
    };
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    let content = '';
    let thinking = '';
    let toolCalls = [];
    let finishReason = null;
    let usage = {};
    await fetchStream(`${provider.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, {
      signal, timeoutMs: provider.timeoutMs || 600_000, ndjson: true,
      onFrame: ({ data }) => {
        const chunk = safeJsonParse(data, null);
        if (!chunk) return;
        const message = chunk.message || {};
        if (typeof message.content === 'string' && message.content) {
          content += message.content;
          onDelta?.(content);
        }
        if (typeof message.thinking === 'string' && message.thinking) thinking += message.thinking;
        if (message.tool_calls?.length) toolCalls = message.tool_calls.map(normalizeToolCall).filter((call) => call.name);
        if (chunk.done) {
          finishReason = chunk.done_reason || 'stop';
          usage = {
            input_tokens: chunk.prompt_eval_count,
            output_tokens: chunk.eval_count,
            total_duration_ns: chunk.total_duration,
          };
        }
      },
    });
    return {
      content, toolCalls, finishReason, usage,
      providerState: { type: 'ollama', ref: resolved.ref, thinking: thinking || undefined },
    };
  }

  async #anthropic(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const cachingEnabled = provider.promptCaching !== false;
    const converted = mergeAnthropicMessages(messages, resolved.ref);

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
      stream: true,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...provider.requestDefaults,
    };
    // Rebuilt block-by-block from `content_block_start`/`_delta`/`_stop` events into the exact
    // same shape the non-streaming endpoint's `content` array used to have, so everything that
    // replays `providerState.blocks` on a later turn keeps working unchanged.
    const blocks = [];
    let content = '';
    let stopReason = null;
    let usage = null;
    await fetchStream(`${provider.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey(provider),
        'anthropic-version': provider.anthropicVersion || '2023-06-01',
        ...provider.headers,
      },
      body: JSON.stringify(body),
    }, {
      signal, timeoutMs: provider.timeoutMs || 300_000,
      onFrame: ({ event, data }) => {
        const payload = safeJsonParse(data, null);
        if (!payload) return;
        if (event === 'message_start') {
          usage = payload.message?.usage || usage;
        } else if (event === 'content_block_start') {
          blocks[payload.index] = { ...payload.content_block };
        } else if (event === 'content_block_delta') {
          const block = blocks[payload.index];
          if (!block) return;
          const delta = payload.delta || {};
          if (delta.type === 'text_delta') {
            block.text = (block.text || '') + delta.text;
            content = blocks.filter((entry) => entry?.type === 'text').map((entry) => entry.text || '').join('\n');
            onDelta?.(content);
          } else if (delta.type === 'input_json_delta') {
            block._argText = (block._argText || '') + (delta.partial_json || '');
          } else if (delta.type === 'thinking_delta') {
            block.thinking = (block.thinking || '') + delta.thinking;
          } else if (delta.type === 'signature_delta') {
            block.signature = (block.signature || '') + delta.signature;
          }
        } else if (event === 'content_block_stop') {
          const block = blocks[payload.index];
          if (block?.type === 'tool_use') {
            block.input = safeJsonParse(block._argText || '{}', {});
            delete block._argText;
          }
        } else if (event === 'message_delta') {
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
          if (payload.usage) usage = { ...usage, ...payload.usage };
        } else if (event === 'error') {
          throw Object.assign(new Error(payload.error?.message || 'Model stream failed'), { data: payload });
        }
      },
    });
    return {
      content: content || blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n'),
      toolCalls: blocks.filter((block) => block?.type === 'tool_use').map((block, index) => normalizeToolCall(block, index)),
      finishReason: stopReason,
      usage,
      providerState: { type: 'anthropic', ref: resolved.ref, blocks },
    };
  }

  async #gemini(resolved, messages, tools, { signal, temperature, maxTokens, onDelta }) {
    const provider = resolved.provider;
    const converted = toGemini(messages, resolved.ref);
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
    // Each SSE frame here is a full GenerateContentResponse, but its parts are the *new* text
    // generated since the previous frame, not the whole answer so far — so parts accumulate
    // across frames the same way the non-streaming endpoint's single response did.
    const parts = [];
    let content = '';
    let finishReason = null;
    let usage = null;
    await fetchStream(`${provider.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(resolved.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey(provider))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...provider.headers }, body: JSON.stringify(body),
    }, {
      signal, timeoutMs: provider.timeoutMs || 300_000,
      onFrame: ({ data }) => {
        const chunk = safeJsonParse(data, null);
        if (!chunk) return;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        for (const part of candidate?.content?.parts || []) {
          parts.push(part);
          // Gemini's "thought" parts are internal reasoning, not visible answer text.
          if (typeof part.text === 'string' && !part.thought) {
            content += part.text;
            onDelta?.(content);
          }
        }
      },
    });
    return {
      content,
      toolCalls: parts.filter((part) => part.functionCall).map((part, index) => normalizeToolCall(part, index)),
      finishReason, usage,
      providerState: { type: 'gemini', ref: resolved.ref, parts },
    };
  }
}
