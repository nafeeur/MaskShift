import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function splitCommand(input) {
  const parts = String(input || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map((part) => part.replace(/^(["'])|(["'])$/g, ''));
}

function interpolate(parts, values) {
  return parts.map((part) => String(part).replace(/\{(audio|output)\}/g, (_, key) => values[key] || ''));
}

function run(command, args, { timeoutMs = 120000, cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Voice command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(stderr.trim() || `Voice command exited with code ${code}`));
    });
  });
}

function defaultRecorder(audioPath, seconds) {
  if (process.platform === 'darwin') return ['ffmpeg', '-y', '-f', 'avfoundation', '-i', ':0', '-t', String(seconds), audioPath];
  if (process.platform === 'linux') return ['ffmpeg', '-y', '-f', 'pulse', '-i', 'default', '-t', String(seconds), audioPath];
  if (process.platform === 'win32') return ['ffmpeg', '-y', '-f', 'dshow', '-i', 'audio=default', '-t', String(seconds), audioPath];
  return null;
}

export class VoiceInput {
  constructor(config = {}) {
    this.config = config || {};
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get durationSeconds() {
    const value = Number(this.config.durationSeconds || process.env.MASKSHIFT_VOICE_SECONDS || 8);
    return Math.min(60, Math.max(1, Number.isFinite(value) ? value : 8));
  }

  async captureAndTranscribe() {
    if (!this.enabled) throw new Error('Voice input is disabled in settings');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'maskshift-voice-'));
    const audioPath = path.join(directory, 'input.wav');
    const outputPath = path.join(directory, 'transcript.txt');
    try {
      await this.record(audioPath);
      return await this.transcribe(audioPath, outputPath);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async record(audioPath) {
    const configured = this.config.recordCommand || process.env.MASKSHIFT_VOICE_RECORD_COMMAND;
    let parts = configured ? splitCommand(configured) : defaultRecorder(audioPath, this.durationSeconds);
    if (!parts?.length) throw new Error('No voice recorder configured. Install ffmpeg or set MASKSHIFT_VOICE_RECORD_COMMAND.');
    parts = interpolate(parts, { audio: audioPath, output: '' });
    if (configured && !parts.some((part) => part === audioPath)) parts.push(audioPath);
    const [command, ...args] = parts;
    await run(command, args, { timeoutMs: (this.durationSeconds + 15) * 1000 });
  }

  async transcribe(audioPath, outputPath) {
    const commandLine = this.config.transcribeCommand || process.env.MASKSHIFT_VOICE_TRANSCRIBE_COMMAND;
    if (!commandLine) {
      throw new Error('No speech-to-text command configured. Set MASKSHIFT_VOICE_TRANSCRIBE_COMMAND, for example a local whisper/whisper.cpp command that accepts {audio}.');
    }
    const parts = interpolate(splitCommand(commandLine), { audio: audioPath, output: outputPath });
    if (!parts.length) throw new Error('Invalid speech-to-text command');
    const [command, ...args] = parts;
    const result = await run(command, args, { timeoutMs: Number(this.config.transcribeTimeoutMs || 120000) });
    let text = result.stdout.trim();
    if (!text && parts.some((part) => part === outputPath)) {
      text = (await readFile(outputPath, 'utf8').catch(() => '')).trim();
    }
    if (!text) throw new Error('Speech-to-text command returned no transcript');
    return text;
  }
}
