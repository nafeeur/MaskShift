// Tiers a tool call has to clear before it runs, keyed by `permissionMode`.
// "autonomous" (the default) never gates anything — see docs/PERMISSIONS.md.
// ("overdrive", the name earlier releases used, is still accepted and means the same.)
// "balanced" gates only the tiers below that can affect the world outside the
// workspace or beyond an automatic checkpoint's reach (host/remote execution,
// secrets, installs, persistent processes, destructive ops, external actions).
// "review" gates every tool call that isn't declared readOnly.
const HIGH_RISK_TIERS = new Set([
  'destructive', 'host-exec', 'remote-exec', 'secrets', 'install',
  'database-write', 'persistent-exec', 'dynamic-load', 'external-action',
]);

import { normalizePermissionMode } from '../core/config.mjs';

export function requiresConfirmation(tool, rawMode) {
  if (!tool || tool.readOnly) return false;
  const permissionMode = normalizePermissionMode(rawMode);
  if (permissionMode === 'review') return true;
  if (permissionMode === 'balanced') return HIGH_RISK_TIERS.has(tool.risk);
  return false;
}
