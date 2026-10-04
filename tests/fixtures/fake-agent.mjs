// A stand-in coding-agent CLI for fleet tests. It reads the briefing MaskShift sends as argv[2] and answers according to
// who it is, so tests can exercise routing without any real harness installed.
import fs from 'node:fs';

const prompt = process.argv[2] || '';
const name = /You are "([^"]+)"/.exec(prompt)?.[1] || 'unknown';
const mail = prompt.includes('Messages for you:');
const flakyMarker = process.env.FAKE_FLAKY_MARKER;

if (flakyMarker && !fs.existsSync(flakyMarker)) {
  fs.writeFileSync(flakyMarker, 'x');
  console.error('transient failure');
  process.exit(3);
}
if (/SLEEP/.test(prompt)) await new Promise((resolve) => setTimeout(resolve, 30_000));
if (/SPAM/.test(prompt)) {
  console.log(`[[send to=${process.env.FAKE_PEER || 'peer'}]] ping from ${name} [[/send]]`);
  process.exit(0);
}
if (name.startsWith('lead')) {
  if (mail && /implemented/.test(prompt)) console.log('[[done]] shipped: feature implemented and reviewed [[/done]]');
  else console.log('Plan ready.\n[[send to=worker]] please implement the feature [[/send]]');
} else if (name.startsWith('worker')) {
  console.log(mail ? 'implemented the feature' : 'worker idle');
} else {
  console.log(`${name} saw: ${prompt.length} chars`);
}
