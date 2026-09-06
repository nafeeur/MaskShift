import fsp from 'node:fs/promises';
import path from 'node:path';
import { absolutePath, commandExists, runCommand, safeJsonParse, shellQuote, truncate } from '../core/utils.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

// Substrings of Ollama model names known to accept image input, so a vision model already
// pulled by the user can be found without requiring separate configuration.
const VISION_MODEL_HINTS = [
  'llava', 'bakllava', 'moondream', 'minicpm-v', 'qwen2-vl', 'qwen2.5vl', 'qwen2.5-vl',
  'llama3.2-vision', 'llama-3.2-vision', 'gemma3', 'granite3.2-vision', 'pixtral',
];

function looksLikeVisionModel(name) {
  const lower = String(name || '').toLowerCase();
  return VISION_MODEL_HINTS.some((hint) => lower.includes(hint));
}

function splitModelRef(ref) {
  const value = String(ref || '');
  const index = value.indexOf(':');
  return index < 0 ? { providerId: null, model: value } : { providerId: value.slice(0, index), model: value.slice(index + 1) };
}

async function pickVisionModel(providerManager, config, override) {
  if (override) return override;
  const configured = config.get().visionModel;
  if (configured) return configured;
  const ollama = config.get().providers.find((item) => item.type === 'ollama' && item.enabled !== false);
  if (!ollama) return null;
  const { models = [] } = await providerManager.discover(ollama.id).catch(() => ({ models: [] }));
  const match = models.find((item) => looksLikeVisionModel(item.id || item.name));
  return match ? `${ollama.id}:${match.id || match.name}` : null;
}

async function ollamaDescribeImage({ baseUrl, headers, model, base64, prompt, signal }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model,
      prompt: prompt || 'Describe this image in detail: layout, any visible text, charts, diagrams, and UI elements.',
      images: [base64],
      stream: false,
    }),
    signal,
  });
  const text = await response.text();
  const data = safeJsonParse(text, null);
  if (!response.ok) throw new Error(data?.error || `Ollama vision request failed: HTTP ${response.status}`);
  if (!data) throw new Error('Ollama returned invalid JSON for the vision request');
  return data.response || '';
}

export function registerVisionTools(registry, { config, providerManager }) {
  registry.register({
    name: 'image_read', title: 'Read an image (OCR + description)',
    description: 'Read an image file: extract any visible text with OCR, and — if a local vision model is available — generate a natural-language description or answer a question about it. Works even when the active chat model has no native vision support, because the description is produced out of band and returned as plain text.',
    category: 'documents', readOnly: true,
    keywords: ['image', 'vision', 'ocr', 'screenshot', 'picture', 'describe image', 'caption', 'diagram', 'chart'],
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string' },
        prompt: { type: 'string', description: 'A specific question to ask about the image, instead of a general description.' },
        ocr: { type: 'boolean', default: true, description: 'Run local OCR (tesseract) over the image.' },
        describe: { type: 'boolean', default: true, description: 'Generate a description via a local Ollama vision model, if one is available.' },
        visionModel: { type: 'string', description: 'Override model reference (provider:model) for the description step, e.g. ollama:llava.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 200_000, default: 20_000 },
      },
    },
    execute: async (args, context) => {
      const target = absolutePath(args.path, context.workspacePath || process.cwd());
      const ext = path.extname(target).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`${target} does not look like a supported image (${[...IMAGE_EXTENSIONS].join(', ')})`);
      }
      let stat;
      try { stat = await fsp.stat(target); } catch { throw new Error(`Image not found: ${target}`); }
      const maxChars = args.maxChars || 20_000;

      const result = { path: target, sizeBytes: stat.size, ocrText: null, description: null, visionModel: null, notes: [] };

      if (args.ocr !== false) {
        if (await commandExists('tesseract')) {
          const ocrResult = await runCommand(`tesseract ${shellQuote(target)} stdout`, { timeoutMs: 60_000, maxOutputChars: maxChars, signal: context.signal });
          if (ocrResult.code === 0) {
            result.ocrText = truncate(ocrResult.stdout.trim(), maxChars) || null;
          } else {
            result.notes.push(`OCR failed: ${truncate(ocrResult.stderr || 'unknown error', 500)}`);
          }
        } else {
          result.notes.push('tesseract is not installed; OCR skipped. Install tesseract-ocr to extract text from images.');
        }
      }

      if (args.describe !== false) {
        const modelRef = await pickVisionModel(providerManager, config, args.visionModel);
        if (!modelRef) {
          result.notes.push('No local vision model configured or discovered; description skipped. Pull one with `ollama pull llava` (or `moondream`, `qwen2.5vl`, ...), or set visionModel / config.visionModel / MASKSHIFT_VISION_MODEL.');
        } else {
          const { providerId, model } = splitModelRef(modelRef);
          const provider = config.get().providers.find((item) => item.id === providerId);
          if (!provider || provider.type !== 'ollama') {
            result.notes.push(`Vision model "${modelRef}" is not an Ollama model; only local Ollama vision models are supported for description right now.`);
          } else {
            try {
              const base64 = (await fsp.readFile(target)).toString('base64');
              const description = await ollamaDescribeImage({
                baseUrl: provider.baseUrl, headers: provider.headers || {}, model,
                base64, prompt: args.prompt, signal: context.signal,
              });
              result.description = truncate(description.trim(), maxChars) || null;
              result.visionModel = modelRef;
            } catch (error) {
              result.notes.push(`Vision description failed: ${error.message}`);
            }
          }
        }
      }

      if (!result.ocrText && !result.description) {
        result.notes.push('No text or description could be extracted from this image.');
      }
      return result;
    },
  });
}
