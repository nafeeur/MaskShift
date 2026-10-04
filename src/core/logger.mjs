import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, nowIso, redactSecrets } from './utils.mjs';

export class Logger {
  constructor({ logFile, auditFile, eventBus }) {
    this.logFile = logFile;
    this.auditFile = auditFile;
    this.eventBus = eventBus;
    this.logStream = null;
    this.auditStream = null;
  }

  async init() {
    await ensureDir(path.dirname(this.logFile));
    await ensureDir(path.dirname(this.auditFile));
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
    this.auditStream = fs.createWriteStream(this.auditFile, { flags: 'a', mode: 0o600 });
  }

  /** Roll a log (or audit) file over once it passes `maxBytes`, keeping the newest `keep` generations: name.1 is the latest. */
  async rotate(which, { maxBytes, keep = 3 } = {}) {
    const file = which === 'audit' ? this.auditFile : this.logFile;
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { return false; }
    if (size <= maxBytes) return false;
    const key = which === 'audit' ? 'auditStream' : 'logStream';
    const old = this[key];
    this[key] = null; // writes during the swap are dropped rather than lost into a closed stream
    await new Promise((resolve) => (old ? old.end(resolve) : resolve()));
    for (let index = keep - 1; index >= 1; index -= 1) await fsp.rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => {});
    await fsp.rename(file, `${file}.1`).catch(() => {});
    await fsp.rm(`${file}.${keep + 1}`, { force: true });
    this[key] = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    return true;
  }

  write(level, message, meta = {}) {
    const record = { timestamp: nowIso(), level, message, ...redactSecrets(meta) };
    this.logStream?.write(`${JSON.stringify(record)}\n`);
    if (level === 'error') console.error(`[MASKSHIFT] ${message}`, meta?.error || '');
    else if (process.env.MASKSHIFT_DEBUG) console.log(`[MASKSHIFT:${level}] ${message}`);
    this.eventBus?.emit('log', record, { runId: meta.runId, sessionId: meta.sessionId });
    return record;
  }

  info(message, meta) { return this.write('info', message, meta); }
  warn(message, meta) { return this.write('warn', message, meta); }
  error(message, meta) { return this.write('error', message, meta); }
  debug(message, meta) { return this.write('debug', message, meta); }

  audit(action, details = {}) {
    const record = { timestamp: nowIso(), action, ...redactSecrets(details) };
    this.auditStream?.write(`${JSON.stringify(record)}\n`);
    this.eventBus?.emit('audit', record, { runId: details.runId, sessionId: details.sessionId });
    return record;
  }

  async tail(lines = 300) {
    try {
      const content = await fsp.readFile(this.logFile, 'utf8');
      return content.trim().split('\n').slice(-lines).map((line) => {
        try { return JSON.parse(line); } catch { return { timestamp: '', level: 'raw', message: line }; }
      });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  close() {
    this.logStream?.end();
    this.auditStream?.end();
  }
}
