// Where a password lives between "the person typed it" and "the browser needs it".
//
// Two homes, and the safe one is the default:
//
//   session   held in this process's memory only and gone when MaskShift exits. Nothing is written.
//   keychain  the operating system's own credential store, reached through tools the OS already
//             ships (macOS `security`, Linux `secret-tool`, Windows' Credential Locker through
//             PowerShell). MaskShift stores no secret itself, and a missing or failing keychain
//             quietly falls back to session memory instead of writing a secret anywhere else.
//
// Values are never put in a command line (which any local user can see in the process list): they
// go through stdin or the environment of the one child process that needs them. Nothing here logs
// a value, and `list()` returns only names.

import { spawn } from 'node:child_process';
import { commandExists } from './utils.mjs';

const SERVICE_PREFIX = 'maskshift:';

function run(command, args, { input = null, env = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    } catch (error) { resolve({ code: 127, stdout: '', stderr: error.message }); return; }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** OS credential stores. Each takes an injectable `runner` so the command shapes can be tested. */
export function keychainBackends(runner = run) {
  return {
    darwin: {
      name: 'macOS Keychain',
      available: () => commandExists('security'),
      async get(service, account) {
        const result = await runner('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
        return result.code === 0 ? result.stdout.replace(/\r?\n$/, '') : null;
      },
      async set(service, account, value) {
        // `security -i` reads commands from stdin, which keeps the password out of the process list.
        const quote = (text) => `"${String(text).replace(/(["\\])/g, '\\$1')}"`;
        const result = await runner('security', ['-i'], { input: `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(value)}\n` });
        return result.code === 0;
      },
      async remove(service, account) {
        const result = await runner('security', ['delete-generic-password', '-s', service, '-a', account]);
        return result.code === 0;
      },
    },
    linux: {
      name: 'Secret Service (secret-tool)',
      available: () => commandExists('secret-tool'),
      async get(service, account) {
        const result = await runner('secret-tool', ['lookup', 'service', service, 'account', account]);
        return result.code === 0 && result.stdout ? result.stdout.replace(/\r?\n$/, '') : null;
      },
      async set(service, account, value) {
        const result = await runner('secret-tool', ['store', `--label=${service}`, 'service', service, 'account', account], { input: value });
        return result.code === 0;
      },
      async remove(service, account) {
        const result = await runner('secret-tool', ['clear', 'service', service, 'account', account]);
        return result.code === 0;
      },
    },
    win32: {
      name: 'Windows Credential Locker',
      available: () => commandExists('powershell'),
      async get(service, account) {
        const script = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; `
          + `try { $c = (New-Object Windows.Security.Credentials.PasswordVault).Retrieve(${psQuote(service)}, ${psQuote(account)}); $c.RetrievePassword(); [Console]::Out.Write($c.Password) } catch { exit 1 }`;
        const result = await runner('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
        return result.code === 0 && result.stdout ? result.stdout : null;
      },
      async set(service, account, value) {
        // The password travels in the environment of this one process, not in its command line.
        const script = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; `
          + `$v = New-Object Windows.Security.Credentials.PasswordVault; `
          + `$v.Add((New-Object Windows.Security.Credentials.PasswordCredential(${psQuote(service)}, ${psQuote(account)}, $env:MASKSHIFT_SECRET_VALUE)))`;
        const result = await runner('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { MASKSHIFT_SECRET_VALUE: value } });
        return result.code === 0;
      },
      async remove(service, account) {
        const script = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; `
          + `try { $v = New-Object Windows.Security.Credentials.PasswordVault; $v.Remove($v.Retrieve(${psQuote(service)}, ${psQuote(account)})) } catch { exit 1 }`;
        const result = await runner('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
        return result.code === 0;
      },
    },
  };
}

export class SecretVault {
  /**
   * `store` supplies get/setSetting for the index of which logins exist (names only, never values);
   * `platform` and `backends` are injectable for tests.
   */
  constructor({ config, logger = null, store = null, platform = process.platform, backends = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.store = store;
    this.platform = platform;
    this.backends = backends || keychainBackends();
    this.memory = new Map();
    this.keychainChecked = null;
  }

  #key(service, account) { return `${service}\u0000${account}`; }
  #serviceName(service) { return `${SERVICE_PREFIX}${String(service).toLowerCase()}`; }

  preferred() {
    return this.config?.get?.().secrets?.backend === 'keychain' ? 'keychain' : 'session';
  }

  async keychainAvailable() {
    if (this.keychainChecked === null) {
      const backend = this.backends[this.platform];
      this.keychainChecked = backend ? Boolean(await backend.available()) : false;
    }
    return this.keychainChecked;
  }

  describe() {
    return { backend: this.preferred(), keychain: this.backends[this.platform]?.name || null };
  }

  async get(service, account) {
    const cached = this.memory.get(this.#key(service, account));
    if (cached !== undefined) return cached;
    if (this.preferred() !== 'keychain' && !this.#indexed(service, account)) return null;
    if (!(await this.keychainAvailable())) return null;
    const value = await this.backends[this.platform].get(this.#serviceName(service), account).catch(() => null);
    if (value) this.memory.set(this.#key(service, account), value);
    return value;
  }

  /** Keeps the value for this session; with `persist`, also in the OS keychain when one works. */
  async set(service, account, value, { persist = false } = {}) {
    this.memory.set(this.#key(service, account), value);
    let persisted = false;
    if (persist && await this.keychainAvailable()) {
      persisted = await this.backends[this.platform].set(this.#serviceName(service), account, value).catch(() => false);
      if (!persisted) this.logger?.warn?.('Could not save a login to the system keychain; it is kept for this session only', { service });
    }
    this.#index(service, account, persisted ? 'keychain' : 'session');
    return { persisted };
  }

  async delete(service, account) {
    this.memory.delete(this.#key(service, account));
    let removed = false;
    if (await this.keychainAvailable()) removed = await this.backends[this.platform].remove(this.#serviceName(service), account).catch(() => false);
    this.#unindex(service, account);
    return { removed };
  }

  list() {
    return this.#entries().map(({ service, account, where }) => ({ service, account, where }));
  }

  // -- the index: which logins exist, by name only
  #entries() { return this.store?.getSetting?.('secrets:index', []) || []; }
  #indexed(service, account) { return this.#entries().some((entry) => entry.service === service && entry.account === account && entry.where === 'keychain'); }
  #index(service, account, where) {
    if (!this.store?.setSetting) return;
    const entries = this.#entries().filter((entry) => !(entry.service === service && entry.account === account));
    entries.push({ service, account, where });
    this.store.setSetting('secrets:index', entries);
  }
  #unindex(service, account) {
    if (!this.store?.setSetting) return;
    this.store.setSetting('secrets:index', this.#entries().filter((entry) => !(entry.service === service && entry.account === account)));
  }
}
