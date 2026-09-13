import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VoiceInput } from '../src/voice/index.mjs';
import { tempDir } from './helpers.mjs';

async function writeScript(directory, name, body) {
  const scriptPath = path.join(directory, name);
  await fsp.writeFile(scriptPath, body);
  return scriptPath;
}

test('captureAndTranscribe records then transcribes via configured commands', async (t) => {
  const scripts = await tempDir(t, 'maskshift-voice-scripts-');
  const recordScript = await writeScript(scripts, 'record.mjs',
    "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'fake-audio-bytes');\n");
  const transcribeScript = await writeScript(scripts, 'transcribe.mjs',
    "process.stdout.write('the safe combination is fourteen twenty-two');\n");

  const voice = new VoiceInput({
    recordCommand: `node ${recordScript} {audio}`,
    transcribeCommand: `node ${transcribeScript} {audio}`,
    durationSeconds: 1,
  });

  const transcript = await voice.captureAndTranscribe();
  assert.equal(transcript, 'the safe combination is fourteen twenty-two');
});

test('transcribe falls back to reading the {output} file when stdout is empty', async (t) => {
  const scripts = await tempDir(t, 'maskshift-voice-scripts-');
  const recordScript = await writeScript(scripts, 'record.mjs',
    "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'fake-audio-bytes');\n");
  const transcribeScript = await writeScript(scripts, 'transcribe.mjs',
    "import fs from 'node:fs'; fs.writeFileSync(process.argv[3], 'written to the output file');\n");

  const voice = new VoiceInput({
    recordCommand: `node ${recordScript} {audio}`,
    transcribeCommand: `node ${transcribeScript} {audio} {output}`,
  });

  const transcript = await voice.captureAndTranscribe();
  assert.equal(transcript, 'written to the output file');
});

test('transcribe without a configured command explains how to fix it', async () => {
  const voice = new VoiceInput({ recordCommand: 'node -e "0"' });
  await assert.rejects(
    () => voice.transcribe('/tmp/does-not-matter.wav', '/tmp/does-not-matter.txt'),
    /No speech-to-text command configured/,
  );
});

test('an empty transcript is treated as a failure, not a blank insert', async (t) => {
  const scripts = await tempDir(t, 'maskshift-voice-scripts-');
  const transcribeScript = await writeScript(scripts, 'transcribe.mjs', "process.stdout.write('');\n");
  const voice = new VoiceInput({ transcribeCommand: `node ${transcribeScript} {audio}` });
  await assert.rejects(
    () => voice.transcribe('/tmp/does-not-matter.wav', '/tmp/does-not-matter.txt'),
    /returned no transcript/,
  );
});

test('a nonzero exit from the transcribe command surfaces its stderr', async (t) => {
  const scripts = await tempDir(t, 'maskshift-voice-scripts-');
  const transcribeScript = await writeScript(scripts, 'transcribe.mjs',
    "process.stderr.write('model weights not found'); process.exit(1);\n");
  const voice = new VoiceInput({ transcribeCommand: `node ${transcribeScript} {audio}` });
  await assert.rejects(
    () => voice.transcribe('/tmp/does-not-matter.wav', '/tmp/does-not-matter.txt'),
    /model weights not found/,
  );
});

test('durationSeconds clamps into a sane range and enabled defaults true', () => {
  const bare = new VoiceInput();
  assert.equal(bare.enabled, true);
  assert.equal(bare.durationSeconds, 8);

  const long = new VoiceInput({ durationSeconds: 999 });
  assert.equal(long.durationSeconds, 60);

  const short = new VoiceInput({ durationSeconds: -5 });
  assert.equal(short.durationSeconds, 1);

  const off = new VoiceInput({ enabled: false });
  assert.equal(off.enabled, false);
});

test('record refuses to run with no configured or platform-default recorder', async () => {
  const voice = new VoiceInput({ recordCommand: '' });
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'sunos' });
  try {
    await assert.rejects(() => voice.record('/tmp/does-not-matter.wav'), /No voice recorder configured/);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});
