import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, safeJsonParse, truncate } from '../core/utils.mjs';

function timeoutSignal(signal, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${timeoutMs} ms`)), timeoutMs);
  timer.unref();
  const abort = () => controller.abort(signal.reason || new Error('Aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, close: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

function htmlToText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function registerWebTools(registry, { config }) {
  registry.register({
    name: 'web_fetch', title: 'Fetch web content',
    description: 'Fetch any HTTP(S) URL with custom method, headers, and body. Returns bounded text, JSON, or readable text extracted from HTML.',
    category: 'web', readOnly: true,
    keywords: ['url', 'docs', 'api', 'download', 'internet'],
    inputSchema: {
      type: 'object', required: ['url'], properties: {
        url: { type: 'string' }, method: { type: 'string', default: 'GET' }, headers: { type: 'object' }, body: {},
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, default: 60000 },
        mode: { type: 'string', enum: ['auto', 'text', 'json', 'readable'], default: 'auto' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 2000000, default: 200000 },
      },
    },
    execute: async (args, context) => {
      const timed = timeoutSignal(context.signal, args.timeoutMs || 60_000);
      try {
        const body = args.body === undefined ? undefined : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body));
        const response = await fetch(args.url, {
          method: args.method || 'GET', headers: { 'User-Agent': 'MaskShift/1.0', ...(body && typeof args.body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...(args.headers || {}) },
          body, signal: timed.signal, redirect: 'follow',
        });
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        const maxChars = Math.min(args.maxChars || 200_000, 2_000_000);
        let content;
        if (args.mode === 'json' || (args.mode === 'auto' && contentType.includes('json'))) content = safeJsonParse(text, text);
        else if (args.mode === 'readable' || (args.mode === 'auto' && contentType.includes('html'))) content = truncate(htmlToText(text), maxChars);
        else content = truncate(text, maxChars);
        return {
          url: response.url, status: response.status, ok: response.ok, statusText: response.statusText,
          contentType, headers: Object.fromEntries(response.headers), content,
          truncated: text.length > maxChars, bytes: Buffer.byteLength(text),
        };
      } finally { timed.close(); }
    },
  });

  registry.register({
    name: 'web_search', title: 'Search the web',
    description: 'Search the public web through DuckDuckGo HTML and return result titles, URLs, and snippets. For specialized search, activate an MCP search provider.',
    category: 'web', readOnly: true,
    keywords: ['internet search', 'research', 'latest', 'lookup'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 } } },
    execute: async (args, context) => {
      const timed = timeoutSignal(context.signal, 45_000);
      try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
          method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 MaskShift/1.0' }, signal: timed.signal,
        });
        const html = await response.text();
        if (!response.ok) throw new Error(`Search HTTP ${response.status}`);
        const results = [];
        const blocks = html.split(/class="result\s+/i).slice(1);
        for (const block of blocks) {
          const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          if (!link) continue;
          const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
          let url = decodeEntities(link[1]);
          try {
            const parsed = new URL(url, 'https://duckduckgo.com');
            url = parsed.searchParams.get('uddg') || parsed.href;
          } catch { /* leave as returned */ }
          results.push({ title: htmlToText(link[2]), url, snippet: htmlToText(snippet?.[1] || snippet?.[2] || '') });
          if (results.length >= (args.limit || 10)) break;
        }
        return { query: args.query, results, provider: 'duckduckgo-html' };
      } finally { timed.close(); }
    },
  });

  registry.register({
    name: 'web_download', title: 'Download URL to file',
    description: 'Download an HTTP(S) response directly to a host or workspace file, creating parent directories.',
    category: 'web', risk: 'write',
    inputSchema: { type: 'object', required: ['url', 'path'], properties: { url: { type: 'string' }, path: { type: 'string' }, headers: { type: 'object' }, timeoutMs: { type: 'integer', default: 300000 }, maxBytes: { type: 'integer', minimum: 1, maximum: 2000000000, default: 500000000 } } },
    execute: async (args, context) => {
      const target = path.isAbsolute(args.path) ? args.path : path.resolve(context.workspacePath || process.cwd(), args.path);
      const timed = timeoutSignal(context.signal, args.timeoutMs || 300_000);
      try {
        const response = await fetch(args.url, { headers: { 'User-Agent': 'MaskShift/1.0', ...(args.headers || {}) }, signal: timed.signal, redirect: 'follow' });
        if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${response.statusText}`);
        const declared = Number(response.headers.get('content-length') || 0);
        const maxBytes = args.maxBytes || 500_000_000;
        if (declared && declared > maxBytes) throw new Error(`Download is ${declared} bytes; maximum is ${maxBytes}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`Download exceeded ${maxBytes} bytes`);
        await ensureDir(path.dirname(target));
        await fsp.writeFile(target, buffer);
        return { url: response.url, path: target, bytes: buffer.length, contentType: response.headers.get('content-type') };
      } finally { timed.close(); }
    },
  });
}
