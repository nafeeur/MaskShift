import { safeJsonParse, truncate } from '../core/utils.mjs';

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

async function fetchJson(url, options, { signal, timeoutMs = 180_000 } = {}) {
  const combined = combineSignals(signal, timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: combined.signal });
  } catch (error) {
    combined.cleanup();
    throw new Error(`Model request failed: ${error.message}`);
  }
  combined.cleanup();
  const text = await response.text();
  const data = safeJsonParse(text, null);
  if (!response.ok) {
    const message = data?.error?.message || data?.message || truncate(text, 4000) || `HTTP ${response.status}`;
    const error = new Error(`${response.status} ${response.statusText}: ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  if (!data) throw new Error(`Provider returned invalid JSON: ${truncate(text, 2000)}`);
  return data;
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

  async complete({ modelRef, messages, tools = [], signal, temperature = 0.1, maxTokens = 16_384 }) {
    const resolved = await this.resolveModel(modelRef);
    const started = Date.now();
    this.eventBus.emit('model.request.started', { provider: resolved.provider.id, model: resolved.model, messages: messages.length, tools: tools.length });
    try {
      let result;
      if (resolved.provider.type === 'anthropic') result = await this.#anthropic(resolved, messages, tools, { signal, temperature, maxTokens });
      else if (resolved.provider.type === 'openai-responses') result = await this.#openAiResponses(resolved, messages, tools, { signal, temperature, maxTokens });
      else if (resolved.provider.type === 'ollama') result = await this.#ollama(resolved, messages, tools, { signal, temperature });
      else if (resolved.provider.type === 'gemini') result = await this.#gemini(resolved, messages, tools, { signal, temperature, maxTokens });
      else result = await this.#openAiCompatible(resolved, messages, tools, { signal, temperature, maxTokens });
      result.modelRef = resolved.ref;
      result.providerId = resolved.provider.id;
      result.providerType = resolved.provider.type;
      result.model = resolved.model;
      result.durationMs = Date.now() - started;
      this.eventBus.emit('model.request.completed', {
        provider: resolved.provider.id, model: resolved.model, durationMs: result.durationMs,
        toolCalls: result.toolCalls.length, usage: result.usage,
      });
      return result;
    } catch (error) {
      this.eventBus.emit('model.request.failed', { provider: resolved.provider.id, model: resolved.model, durationMs: Date.now() - started, error: error.message });
      throw error;
    }
  }

  async #openAiResponses(resolved, messages, tools, { signal, temperature, maxTokens }) {
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
    const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, { signal, timeoutMs: provider.timeoutMs || 300_000 });
    const output = data.output || [];
    const content = output.filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === 'output_text' || typeof item.text === 'string')
      .map((item) => item.text || '').join('\n');
    const toolCalls = output.filter((item) => item.type === 'function_call').map((item, index) => normalizeToolCall({
      id: item.call_id || item.id, name: item.name, arguments: item.arguments,
    }, index)).filter((call) => call.name);
    return {
      content: content || data.output_text || '',
      toolCalls,
      finishReason: data.status || null,
      usage: data.usage || null,
      responseId: data.id || null,
    };
  }

  async #openAiCompatible(resolved, messages, tools, { signal, temperature, maxTokens }) {
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
    const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, { signal, timeoutMs: provider.timeoutMs || 300_000 });
    const choice = data.choices?.[0] || {};
    const message = choice.message || {};
    return {
      content: typeof message.content === 'string' ? message.content : (message.content || []).map((item) => item.text || '').join(''),
      toolCalls: (message.tool_calls || []).map(normalizeToolCall).filter((call) => call.name),
      finishReason: choice.finish_reason || null,
      usage: data.usage || null,
    };
  }

  async #ollama(resolved, messages, tools, { signal, temperature }) {
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
    const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }, { signal, timeoutMs: provider.timeoutMs || 600_000 });
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

  async #anthropic(resolved, messages, tools, { signal, temperature, maxTokens }) {
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
    const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey(provider),
        'anthropic-version': provider.anthropicVersion || '2023-06-01',
        ...provider.headers,
      },
      body: JSON.stringify(body),
    }, { signal, timeoutMs: provider.timeoutMs || 300_000 });
    const blocks = data.content || [];
    return {
      content: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
      toolCalls: blocks.filter((block) => block.type === 'tool_use').map((block, index) => normalizeToolCall(block, index)),
      finishReason: data.stop_reason || null,
      usage: data.usage || null,
    };
  }

  async #gemini(resolved, messages, tools, { signal, temperature, maxTokens }) {
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
    const data = await fetchJson(`${provider.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(resolved.model)}:generateContent?key=${encodeURIComponent(this.apiKey(provider))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...provider.headers }, body: JSON.stringify(body),
    }, { signal, timeoutMs: provider.timeoutMs || 300_000 });
    const candidate = data.candidates?.[0] || {};
    const parts = candidate.content?.parts || [];
    return {
      content: parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('\n'),
      toolCalls: parts.filter((part) => part.functionCall).map((part, index) => normalizeToolCall(part, index)),
      finishReason: candidate.finishReason || null,
      usage: data.usageMetadata || null,
    };
  }
}
