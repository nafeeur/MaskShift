// A desktop notification when a run finishes while nobody's looking at the
// terminal. Same shape as voice/index.mjs: a sane per-platform default, a
// fully configurable override command, and it never throws into the caller
// — a failed notification is a shrug, not a broken run.

import { spawn } from 'node:child_process';

function splitCommand(input) {
  const parts = String(input || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map((part) => part.replace(/^(["'])|(["'])$/g, ''));
}

function interpolate(parts, values) {
  return parts.map((part) => String(part).replace(/\{(title|message)\}/g, (_, key) => values[key] || ''));
}

/** Quote a string for the single AppleScript/PowerShell argument it's
 *  embedded in — these run through `-e`/`-Command`, not a shell, so this
 *  only has to survive that one literal, not a full shell grammar. */
function quote(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function defaultCommand(title, message) {
  if (process.platform === 'darwin') {
    return ['osascript', '-e', `display notification "${quote(message)}" with title "${quote(title)}"`];
  }
  if (process.platform === 'linux') {
    return ['notify-send', title, message];
  }
  if (process.platform === 'win32') {
    // No notify-send equivalent ships with Windows; a balloon tip via the
    // .NET Forms API is the one thing guaranteed present on any box with
    // PowerShell, no extra install required.
    const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
      `$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ` +
      `$n.ShowBalloonTip(8000, "${quote(title)}", "${quote(message)}", [System.Windows.Forms.ToolTipIcon]::Info); ` +
      `Start-Sleep -Seconds 1; $n.Dispose()`;
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command', script];
  }
  return null;
}

/** Fire a desktop notification. Resolves once the command has been
 *  launched (not once it's been *seen* — these are all fire-and-forget
 *  CLIs) and never rejects; failures are reported through `onError` only,
 *  so a missing `notify-send` binary never surfaces as a run-ending error. */
export function notify({ title, message, command = null }, { onError = null } = {}) {
  const argv = command ? interpolate(splitCommand(command), { title, message }) : defaultCommand(title, message);
  if (!argv || !argv.length) { onError?.(new Error(`No notification command available for ${process.platform}`)); return; }
  try {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: false });
    child.on('error', (error) => onError?.(error));
    child.unref?.();
  } catch (error) {
    onError?.(error);
  }
}
