import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { absolutePath, commandExists, ensureDir, id, runCommand, shellQuote, truncate } from '../core/utils.mjs';

function cwdFor(args, context) {
  const root = context.workspacePath || process.cwd();
  return args.cwd ? absolutePath(args.cwd, root) : root;
}

async function engine(preferred = null) {
  for (const name of [preferred, 'docker', 'podman'].filter(Boolean)) {
    const executable = await commandExists(name);
    if (executable) return { name, executable };
  }
  throw new Error('Neither Docker nor Podman is installed');
}

function stringifyArgs(values = []) {
  return values.map((value) => shellQuote(value)).join(' ');
}

function normalizeSqlValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { type: 'blob', base64: value.toString('base64'), bytes: value.length };
  return value;
}

function rowObject(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)]));
}

async function tempScript(language, code) {
  const extension = language === 'python' ? 'py' : 'mjs';
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-cell-'));
  const file = path.join(directory, `${id('cell')}.${extension}`);
  await fsp.writeFile(file, code, 'utf8');
  return { directory, file };
}

export function registerPlatformTools(registry, { config }) {
  registry.register({
    name: 'container_engine', title: 'Inspect container engine', description: 'Detect Docker or Podman and return version and runtime information.',
    category: 'containers', readOnly: true, keywords: ['docker', 'podman', 'container'],
    inputSchema: { type: 'object', properties: { engine: { type: 'string', enum: ['docker', 'podman'] } } },
    execute: async (args) => {
      const selected = await engine(args.engine);
      const version = await runCommand(`${shellQuote(selected.executable)} version --format json`, { timeoutMs: 20_000, maxOutputChars: 40_000 });
      if (version.code !== 0) {
        const fallback = await runCommand(`${shellQuote(selected.executable)} version`, { timeoutMs: 20_000, maxOutputChars: 40_000 });
        return { ...selected, available: true, code: fallback.code, output: fallback.stdout || fallback.stderr };
      }
      return { ...selected, available: true, code: version.code, output: version.stdout };
    },
  });

  registry.register({
    name: 'container_list', title: 'List containers', description: 'List running or stopped Docker/Podman containers as structured records.',
    category: 'containers', readOnly: true,
    inputSchema: { type: 'object', properties: { engine: { type: 'string' }, all: { type: 'boolean', default: true }, filters: { type: 'array', items: { type: 'string' } } } },
    execute: async (args) => {
      const selected = await engine(args.engine);
      const flags = [args.all !== false ? '--all' : '', ...(args.filters || []).flatMap((filter) => ['--filter', filter])].filter(Boolean);
      const result = await runCommand(`${shellQuote(selected.executable)} ps ${stringifyArgs(flags)} --format '{{json .}}'`, { timeoutMs: 30_000, maxOutputChars: 100_000 });
      const containers = result.stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
      return { engine: selected.name, code: result.code, containers, stderr: result.stderr };
    },
  });

  registry.register({
    name: 'container_run', title: 'Run container', description: 'Run any Docker/Podman image with ports, volumes, environment, network, privilege, and detach controls.',
    category: 'containers', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['image'], properties: {
      engine: { type: 'string' }, image: { type: 'string' }, command: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      name: { type: 'string' }, detach: { type: 'boolean', default: false }, remove: { type: 'boolean', default: true },
      ports: { type: 'array', items: { type: 'string' } }, volumes: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', additionalProperties: { type: 'string' } }, workdir: { type: 'string' }, network: { type: 'string' },
      privileged: { type: 'boolean', default: false }, extraArgs: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer', maximum: 7200000 }, cwd: { type: 'string' },
    } },
    execute: async (args, context) => {
      const selected = await engine(args.engine);
      const flags = [
        args.detach ? '-d' : '', args.remove !== false && !args.detach ? '--rm' : '', args.name ? `--name=${args.name}` : '',
        args.privileged ? '--privileged' : '', args.workdir ? `--workdir=${args.workdir}` : '', args.network ? `--network=${args.network}` : '',
        ...(args.ports || []).map((item) => `--publish=${item}`), ...(args.volumes || []).map((item) => `--volume=${item}`),
        ...Object.entries(args.env || {}).map(([key, value]) => `--env=${key}=${value}`), ...(args.extraArgs || []),
      ].filter(Boolean);
      const command = Array.isArray(args.command) ? stringifyArgs(args.command) : (args.command || '');
      return runCommand(`${shellQuote(selected.executable)} run ${stringifyArgs(flags)} ${shellQuote(args.image)} ${command}`, {
        cwd: cwdFor(args, context), timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal,
      });
    },
  });

  registry.register({
    name: 'container_exec', title: 'Execute in container', description: 'Execute a command in an existing Docker/Podman container.',
    category: 'containers', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['container', 'command'], properties: { engine: { type: 'string' }, container: { type: 'string' }, command: { type: 'string' }, user: { type: 'string' }, workdir: { type: 'string' }, env: { type: 'object' }, interactive: { type: 'boolean', default: false }, timeoutMs: { type: 'integer', maximum: 7200000 } } },
    execute: async (args, context) => {
      const selected = await engine(args.engine);
      const flags = [args.interactive ? '-i' : '', args.user ? `--user=${args.user}` : '', args.workdir ? `--workdir=${args.workdir}` : '', ...Object.entries(args.env || {}).map(([key, value]) => `--env=${key}=${value}`)].filter(Boolean);
      return runCommand(`${shellQuote(selected.executable)} exec ${stringifyArgs(flags)} ${shellQuote(args.container)} sh -lc ${shellQuote(args.command)}`, { timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal });
    },
  });

  registry.register({
    name: 'container_logs', title: 'Read container logs', description: 'Read recent container logs with timestamps, tail, and since controls.',
    category: 'containers', readOnly: true,
    inputSchema: { type: 'object', required: ['container'], properties: { engine: { type: 'string' }, container: { type: 'string' }, tail: { type: 'integer', default: 500 }, since: { type: 'string' }, timestamps: { type: 'boolean', default: true } } },
    execute: async (args) => { const selected = await engine(args.engine); const flags = [`--tail=${args.tail || 500}`, args.since ? `--since=${args.since}` : '', args.timestamps !== false ? '--timestamps' : ''].filter(Boolean); return runCommand(`${shellQuote(selected.executable)} logs ${stringifyArgs(flags)} ${shellQuote(args.container)}`, { timeoutMs: 30_000, maxOutputChars: config.get().maxToolOutputChars }); },
  });

  registry.register({
    name: 'container_stop', title: 'Stop or remove container', description: 'Stop, kill, restart, pause, unpause, or remove a container.',
    category: 'containers', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['container'], properties: { engine: { type: 'string' }, container: { type: 'string' }, action: { type: 'string', enum: ['stop', 'kill', 'restart', 'pause', 'unpause', 'rm'], default: 'stop' }, force: { type: 'boolean', default: false }, timeout: { type: 'integer', default: 10 } } },
    execute: async (args) => { const selected = await engine(args.engine); const flags = args.action === 'rm' && args.force ? ['--force'] : args.action === 'stop' ? [`--time=${args.timeout || 10}`] : []; return runCommand(`${shellQuote(selected.executable)} ${args.action || 'stop'} ${stringifyArgs(flags)} ${shellQuote(args.container)}`, { timeoutMs: 60_000, maxOutputChars: 40_000 }); },
  });

  registry.register({
    name: 'container_build', title: 'Build container image', description: 'Build a Docker/Podman image from a Dockerfile or Containerfile with build args and tags.',
    category: 'containers', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['tag'], properties: { engine: { type: 'string' }, tag: { type: 'string' }, context: { type: 'string', default: '.' }, file: { type: 'string' }, buildArgs: { type: 'object' }, target: { type: 'string' }, noCache: { type: 'boolean', default: false }, pull: { type: 'boolean', default: false }, extraArgs: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer', maximum: 7200000 }, cwd: { type: 'string' } } },
    execute: async (args, context) => { const selected = await engine(args.engine); const flags = [`--tag=${args.tag}`, args.file ? `--file=${args.file}` : '', args.target ? `--target=${args.target}` : '', args.noCache ? '--no-cache' : '', args.pull ? '--pull' : '', ...Object.entries(args.buildArgs || {}).map(([key, value]) => `--build-arg=${key}=${value}`), ...(args.extraArgs || [])].filter(Boolean); return runCommand(`${shellQuote(selected.executable)} build ${stringifyArgs(flags)} ${shellQuote(args.context || '.')}`, { cwd: cwdFor(args, context), timeoutMs: args.timeoutMs || 1_800_000, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); },
  });

  registry.register({
    name: 'container_compose', title: 'Run Compose', description: 'Run Docker Compose or Podman Compose actions such as up, down, build, logs, ps, and config.',
    category: 'containers', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['action'], properties: { engine: { type: 'string' }, action: { type: 'string' }, services: { type: 'array', items: { type: 'string' } }, file: { type: 'string' }, projectName: { type: 'string' }, detach: { type: 'boolean', default: false }, extraArgs: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', maximum: 7200000 } } },
    execute: async (args, context) => { const selected = await engine(args.engine); const prefix = selected.name === 'docker' ? `${shellQuote(selected.executable)} compose` : (await commandExists('podman-compose') ? 'podman-compose' : `${shellQuote(selected.executable)} compose`); const flags = [args.file ? `--file=${args.file}` : '', args.projectName ? `--project-name=${args.projectName}` : ''].filter(Boolean); const actionArgs = [args.action, args.detach ? '--detach' : '', ...(args.extraArgs || []), ...(args.services || [])].filter(Boolean); return runCommand(`${prefix} ${stringifyArgs(flags)} ${stringifyArgs(actionArgs)}`, { cwd: cwdFor(args, context), timeoutMs: args.timeoutMs || 1_800_000, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); },
  });

  registry.register({
    name: 'kubernetes_exec', title: 'Run kubectl', description: 'Execute any kubectl operation with a structured argument list and optional context, namespace, and kubeconfig.',
    category: 'containers', risk: 'remote-exec', keywords: ['kubernetes', 'kubectl', 'cluster'],
    inputSchema: { type: 'object', required: ['args'], properties: { args: { type: 'array', items: { type: 'string' } }, context: { type: 'string' }, namespace: { type: 'string' }, kubeconfig: { type: 'string' }, timeoutMs: { type: 'integer', maximum: 7200000 }, cwd: { type: 'string' } } },
    execute: async (args, context) => { const executable = await commandExists('kubectl'); if (!executable) throw new Error('kubectl is not installed'); const flags = [args.context ? `--context=${args.context}` : '', args.namespace ? `--namespace=${args.namespace}` : '', args.kubeconfig ? `--kubeconfig=${args.kubeconfig}` : '', ...(args.args || [])].filter(Boolean); return runCommand(`${shellQuote(executable)} ${stringifyArgs(flags)}`, { cwd: cwdFor(args, context), timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); },
  });

  registry.register({
    name: 'ssh_exec', title: 'Execute over SSH', description: 'Run a command on any SSH host with user, port, identity, jump host, environment, and timeout controls.',
    category: 'remote', risk: 'remote-exec', keywords: ['ssh', 'remote host', 'server'],
    inputSchema: { type: 'object', required: ['host', 'command'], properties: { host: { type: 'string' }, user: { type: 'string' }, port: { type: 'integer', default: 22 }, identityFile: { type: 'string' }, jumpHost: { type: 'string' }, command: { type: 'string' }, env: { type: 'object' }, connectTimeout: { type: 'integer', default: 15 }, timeoutMs: { type: 'integer', maximum: 7200000 }, strictHostKeyChecking: { type: 'boolean', default: true } } },
    execute: async (args, context) => { const executable = await commandExists('ssh'); if (!executable) throw new Error('ssh is not installed'); const target = `${args.user ? `${args.user}@` : ''}${args.host}`; const flags = ['-p', String(args.port || 22), '-o', `ConnectTimeout=${args.connectTimeout || 15}`, '-o', `StrictHostKeyChecking=${args.strictHostKeyChecking === false ? 'no' : 'yes'}`, args.identityFile ? `-i ${shellQuote(args.identityFile)}` : '', args.jumpHost ? `-J ${shellQuote(args.jumpHost)}` : ''].filter(Boolean).join(' '); const exports = Object.entries(args.env || {}).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' '); return runCommand(`${shellQuote(executable)} ${flags} ${shellQuote(target)} ${shellQuote(`${exports} ${args.command}`.trim())}`, { timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); },
  });

  registry.register({
    name: 'rsync_transfer', title: 'Transfer files with rsync', description: 'Synchronize local and remote files with rsync over SSH.',
    category: 'remote', risk: 'remote-exec',
    inputSchema: { type: 'object', required: ['source', 'destination'], properties: { source: { type: 'string' }, destination: { type: 'string' }, archive: { type: 'boolean', default: true }, delete: { type: 'boolean', default: false }, compress: { type: 'boolean', default: true }, dryRun: { type: 'boolean', default: false }, excludes: { type: 'array', items: { type: 'string' } }, extraArgs: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', maximum: 7200000 } } },
    execute: async (args, context) => { const executable = await commandExists('rsync'); if (!executable) throw new Error('rsync is not installed'); const flags = [args.archive !== false ? '--archive' : '', args.compress !== false ? '--compress' : '', args.delete ? '--delete' : '', args.dryRun ? '--dry-run' : '', '--human-readable', '--info=stats2,progress2', ...(args.excludes || []).map((item) => `--exclude=${item}`), ...(args.extraArgs || [])].filter(Boolean); return runCommand(`${shellQuote(executable)} ${stringifyArgs(flags)} ${shellQuote(args.source)} ${shellQuote(args.destination)}`, { cwd: cwdFor(args, context), timeoutMs: args.timeoutMs || 1_800_000, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); },
  });

  registry.register({
    name: 'sqlite_query', title: 'Query SQLite database', description: 'Open any SQLite database directly through Node native SQLite, execute parameterized SQL, and return structured rows. Write statements are allowed.',
    category: 'database', risk: 'database-write', keywords: ['sqlite', 'sql', 'database', 'query'],
    inputSchema: { type: 'object', required: ['database', 'sql'], properties: { database: { type: 'string' }, sql: { type: 'string' }, parameters: { oneOf: [{ type: 'array' }, { type: 'object' }] }, readOnly: { type: 'boolean', default: false }, maxRows: { type: 'integer', minimum: 1, maximum: 100000, default: 5000 } } },
    execute: async (args, context) => {
      const file = absolutePath(args.database, context.workspacePath || process.cwd());
      await ensureDir(path.dirname(file));
      const db = new DatabaseSync(file, { readOnly: Boolean(args.readOnly) });
      try {
        const statement = db.prepare(args.sql);
        const params = args.parameters || [];
        const values = Array.isArray(params) ? params : [params];
        if (statement.columns().length) {
          const rows = statement.all(...values).slice(0, args.maxRows || 5000).map(rowObject);
          return { database: file, columns: statement.columns().map((item) => item.name), rows, rowCount: rows.length };
        }
        const result = statement.run(...values);
        return { database: file, changes: Number(result.changes), lastInsertRowid: normalizeSqlValue(result.lastInsertRowid) };
      } finally { db.close(); }
    },
  });

  registry.register({
    name: 'sqlite_schema', title: 'Inspect SQLite schema', description: 'Return tables, views, indexes, triggers, and CREATE statements from a SQLite database.',
    category: 'database', readOnly: true,
    inputSchema: { type: 'object', required: ['database'], properties: { database: { type: 'string' }, includeInternal: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const file = absolutePath(args.database, context.workspacePath || process.cwd());
      const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master ${args.includeInternal ? '' : "WHERE name NOT LIKE 'sqlite_%'"} ORDER BY type, name`).all().map(rowObject); } finally { db.close(); }
    },
  });

  registry.register({
    name: 'database_cli', title: 'Run database CLI', description: 'Execute a command through psql, mysql, redis-cli, mongosh, duckdb, or another installed database client.',
    category: 'database', risk: 'database-write',
    inputSchema: { type: 'object', required: ['client', 'args'], properties: { client: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, env: { type: 'object' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', maximum: 7200000 } } },
    execute: async (args, context) => { const executable = await commandExists(args.client); if (!executable) throw new Error(`Database client is not installed: ${args.client}`); return runCommand(`${shellQuote(executable)} ${stringifyArgs(args.args || [])}`, { cwd: cwdFor(args, context), env: args.env || {}, timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); },
  });

  registry.register({
    name: 'archive_create', title: 'Create archive', description: 'Create tar.gz, tar.zst, tar, or zip archives from arbitrary host paths.',
    category: 'artifacts', risk: 'write', keywords: ['zip', 'tar', 'compress', 'artifact'],
    inputSchema: { type: 'object', required: ['output', 'paths'], properties: { output: { type: 'string' }, paths: { type: 'array', minItems: 1, items: { type: 'string' } }, format: { type: 'string', enum: ['auto', 'tar.gz', 'tar.zst', 'tar', 'zip'], default: 'auto' }, cwd: { type: 'string' } } },
    execute: async (args, context) => {
      const cwd = cwdFor(args, context); const output = absolutePath(args.output, cwd); await ensureDir(path.dirname(output));
      let format = args.format || 'auto';
      if (format === 'auto') format = output.endsWith('.zip') ? 'zip' : output.endsWith('.tar.zst') || output.endsWith('.tzst') ? 'tar.zst' : output.endsWith('.tar') ? 'tar' : 'tar.gz';
      const command = format === 'zip' ? `zip -r ${shellQuote(output)} ${stringifyArgs(args.paths)}` : `tar ${format === 'tar.gz' ? '-czf' : format === 'tar.zst' ? '--zstd -cf' : '-cf'} ${shellQuote(output)} ${stringifyArgs(args.paths)}`;
      const result = await runCommand(command, { cwd, timeoutMs: 1_800_000, maxOutputChars: 60_000 });
      const stat = result.code === 0 ? await fsp.stat(output) : null;
      return { ...result, output, bytes: stat?.size || 0, format };
    },
  });

  registry.register({
    name: 'archive_extract', title: 'Extract archive', description: 'Extract zip, tar.gz, tar.zst, tar, and common compressed archives.',
    category: 'artifacts', risk: 'write',
    inputSchema: { type: 'object', required: ['archive'], properties: { archive: { type: 'string' }, destination: { type: 'string', default: '.' }, stripComponents: { type: 'integer', minimum: 0, maximum: 20, default: 0 }, cwd: { type: 'string' } } },
    execute: async (args, context) => { const cwd = cwdFor(args, context); const archive = absolutePath(args.archive, cwd); const destination = absolutePath(args.destination || '.', cwd); await ensureDir(destination); const command = archive.endsWith('.zip') ? `unzip -o ${shellQuote(archive)} -d ${shellQuote(destination)}` : `tar -xf ${shellQuote(archive)} -C ${shellQuote(destination)} ${args.stripComponents ? `--strip-components=${Number(args.stripComponents)}` : ''}`; return { ...(await runCommand(command, { cwd, timeoutMs: 1_800_000, maxOutputChars: 60_000 })), archive, destination }; },
  });

  registry.register({
    name: 'file_hash', title: 'Hash file', description: 'Calculate SHA-256, SHA-512, SHA-1, or MD5 for a file without loading it all into model context.',
    category: 'artifacts', readOnly: true,
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, algorithm: { type: 'string', enum: ['sha256', 'sha512', 'sha1', 'md5'], default: 'sha256' } } },
    execute: async (args, context) => { const file = absolutePath(args.path, context.workspacePath || process.cwd()); const hash = crypto.createHash(args.algorithm || 'sha256'); const handle = await fsp.open(file, 'r'); try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close().catch(() => {}); } const stat = await fsp.stat(file); return { path: file, algorithm: args.algorithm || 'sha256', digest: hash.digest('hex'), bytes: stat.size }; },
  });

  registry.register({
    name: 'python_cell', title: 'Execute Python cell', description: 'Execute an arbitrary Python code cell in a temporary script with workspace cwd and return stdout/stderr.',
    category: 'runtimes', risk: 'host-exec', keywords: ['python', 'notebook', 'data analysis', 'script'],
    inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, python: { type: 'string', default: 'python3' }, args: { type: 'array', items: { type: 'string' } }, env: { type: 'object' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', maximum: 7200000 }, keep: { type: 'boolean', default: false } } },
    execute: async (args, context) => { const script = await tempScript('python', args.code); try { const executable = await commandExists(args.python || 'python3'); if (!executable) throw new Error(`Python executable not found: ${args.python || 'python3'}`); const result = await runCommand(`${shellQuote(executable)} ${shellQuote(script.file)} ${stringifyArgs(args.args || [])}`, { cwd: cwdFor(args, context), env: args.env || {}, timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); return { ...result, script: args.keep ? script.file : null }; } finally { if (!args.keep) await fsp.rm(script.directory, { recursive: true, force: true }); } },
  });

  registry.register({
    name: 'node_cell', title: 'Execute Node.js cell', description: 'Execute arbitrary JavaScript as an ES module in a temporary script with workspace cwd.',
    category: 'runtimes', risk: 'host-exec', keywords: ['node', 'javascript', 'notebook', 'script'],
    inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, node: { type: 'string', default: 'node' }, args: { type: 'array', items: { type: 'string' } }, env: { type: 'object' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', maximum: 7200000 }, keep: { type: 'boolean', default: false } } },
    execute: async (args, context) => { const script = await tempScript('node', args.code); try { const executable = await commandExists(args.node || 'node'); if (!executable) throw new Error(`Node executable not found: ${args.node || 'node'}`); const result = await runCommand(`${shellQuote(executable)} ${shellQuote(script.file)} ${stringifyArgs(args.args || [])}`, { cwd: cwdFor(args, context), env: args.env || {}, timeoutMs: args.timeoutMs || config.get().commandTimeoutMs, maxOutputChars: config.get().maxToolOutputChars, signal: context.signal }); return { ...result, script: args.keep ? script.file : null }; } finally { if (!args.keep) await fsp.rm(script.directory, { recursive: true, force: true }); } },
  });

  registry.register({
    name: 'environment_list', title: 'Read environment', description: 'List process environment variable names and optionally values. MaskShift overdrive mode permits direct secret-bearing environment access.',
    category: 'system', readOnly: true, risk: 'secrets',
    inputSchema: { type: 'object', properties: { includeValues: { type: 'boolean', default: false }, filter: { type: 'string' } } },
    execute: async (args) => { const expression = args.filter ? new RegExp(args.filter, 'i') : null; return Object.fromEntries(Object.entries(process.env).filter(([key]) => !expression || expression.test(key)).map(([key, value]) => [key, args.includeValues ? value : true])); },
  });

  registry.register({
    name: 'environment_set', title: 'Set runtime environment', description: 'Set or delete environment variables for this running MaskShift daemon and future child processes.',
    category: 'system', risk: 'secrets',
    inputSchema: { type: 'object', properties: { values: { type: 'object', additionalProperties: { type: ['string', 'null'] } } } },
    execute: async (args) => { for (const [key, value] of Object.entries(args.values || {})) { if (value === null) delete process.env[key]; else process.env[key] = String(value); } return { updated: Object.keys(args.values || {}) }; },
  });

  registry.register({
    name: 'port_inspect', title: 'Inspect network ports', description: 'Inspect listening sockets and processes using ss, netstat, or lsof.',
    category: 'system', readOnly: true,
    inputSchema: { type: 'object', properties: { port: { type: 'integer', minimum: 1, maximum: 65535 }, protocol: { type: 'string', enum: ['tcp', 'udp', 'all'], default: 'all' } } },
    execute: async (args) => { const ss = await commandExists('ss'); const lsof = await commandExists('lsof'); const command = ss ? `${shellQuote(ss)} -lntup ${args.port ? `'( sport = :${Number(args.port)} )'` : ''}` : lsof ? `${shellQuote(lsof)} -nP -i${args.protocol === 'tcp' ? 'TCP' : args.protocol === 'udp' ? 'UDP' : ''}${args.port ? `:${Number(args.port)}` : ''}` : 'netstat -anp'; return runCommand(command, { timeoutMs: 20_000, maxOutputChars: 80_000 }); },
  });

  registry.register({
    name: 'system_service', title: 'Control system service', description: 'Inspect, start, stop, restart, reload, enable, or disable a systemd service on the host.',
    category: 'system', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['service'], properties: { service: { type: 'string' }, action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable'], default: 'status' }, user: { type: 'boolean', default: false }, sudo: { type: 'boolean', default: false } } },
    execute: async (args) => { const executable = await commandExists('systemctl'); if (!executable) throw new Error('systemctl is not installed'); return runCommand(`${args.sudo ? 'sudo ' : ''}${shellQuote(executable)} ${args.user ? '--user ' : ''}${args.action || 'status'} ${shellQuote(args.service)}`, { timeoutMs: 120_000, maxOutputChars: 80_000 }); },
  });
}
