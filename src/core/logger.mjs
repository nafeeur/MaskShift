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
