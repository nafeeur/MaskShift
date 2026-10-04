// How much room MaskShift may take, worked out from the machine it is running on.
//
// Nothing here is a fixed number of gigabytes. A 64 GB laptop with 12 GB free and a 2 TB workstation should not share
// limits, so every default comes from three measurements: the disk the data lives on (total and free), the memory of
// the host, and how much MaskShift already occupies.
//
//   budget      = 5% of the disk, but never more than a quarter of what MaskShift could reclaim (free space plus its own
//                 usage), clamped to 1–40 GiB (below 1 GiB only when the disk itself is that small)
//   pressure    = how scarce free space is: roomy / normal / tight / critical. It scales every retention window.
//   split       = 35% searchable index, 45% checkpoints, 20% everything else (browser profiles, logs, artifacts)
//   index cap   = the text one workspace may contribute, limited by the index share (the database is roughly 3.5x the
//                 indexed text once the full-text index and its copy are counted) and by RAM, because the indexer holds
//                 a workspace's chunks in memory while it works
//
// Anything the user sets in `storage` in the config wins over what is derived here.

import fsp from 'node:fs/promises';
import os from 'node:os';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** What this machine looks like right now. `dir` must be on the volume that holds MaskShift's data. */
export async function probeHost(dir) {
  let diskTotal = 0;
  let diskFree = 0;
  try {
    const stats = await fsp.statfs(dir);
    diskTotal = Number(stats.blocks) * Number(stats.bsize);
    diskFree = Number(stats.bavail) * Number(stats.bsize);
  } catch { /* statfs is missing on some platforms or filesystems; the budget then falls back to memory-based limits */ }
  return { diskTotal, diskFree, memTotal: os.totalmem(), cpus: os.cpus().length || 1, platform: process.platform };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function pressureOf(host) {
  if (!host.diskTotal) return 'normal';
  const fraction = host.diskFree / host.diskTotal;
  if (host.diskFree < 2 * GiB || fraction < 0.03) return 'critical';
  if (host.diskFree < 10 * GiB || fraction < 0.10) return 'tight';
  if (host.diskFree > 100 * GiB && fraction > 0.30) return 'roomy';
  return 'normal';
}

const FACTOR = { critical: 0.25, tight: 0.5, normal: 1, roomy: 1.5 };

/**
 * @param host        result of probeHost()
 * @param usedBytes   what MaskShift occupies now, so a nearly full disk does not make the budget collapse onto data
 *                    that is already there
 * @param overrides   the `storage` section of the config; null/undefined means "work it out"
 */
export function computeBudget(host, usedBytes = 0, overrides = {}) {
  const pressure = pressureOf(host);
  const factor = FACTOR[pressure];
  let total;
  if (overrides.maxGb) {
    total = overrides.maxGb * GiB;
  } else if (host.diskTotal) {
    const reclaimable = host.diskFree + usedBytes;
    total = Math.min(0.05 * host.diskTotal, 0.25 * reclaimable);
    total = clamp(total, Math.min(1 * GiB, 0.5 * reclaimable), 40 * GiB);
  } else {
    total = clamp(host.memTotal * 0.25, 1 * GiB, 8 * GiB);
  }

  total = Math.round(total);
  const share = { index: Math.round(total * 0.35), checkpoints: Math.round(total * 0.45), other: total - Math.round(total * 0.35) - Math.round(total * 0.45) };
  const memGiB = host.memTotal / GiB;

  const indexTextPerWorkspace = overrides.indexMaxMb
    ? overrides.indexMaxMb * MiB
    : Math.round(clamp(Math.min(share.index / 7, host.memTotal * 0.03), 20 * MiB, 600 * MiB));
  const keepCheckpoints = overrides.keepCheckpoints ?? Math.max(3, Math.round(20 * factor));
  const checkpointMaxAgeDays = overrides.checkpointMaxAgeDays ?? Math.max(2, Math.round(14 * factor));

  return {
    pressure,
    host,
    total,
    share,
    index: {
      maxTextBytes: indexTextPerWorkspace,
      maxFiles: overrides.indexMaxFiles ?? Math.round(clamp(memGiB * 10_000, 20_000, 150_000)),
      maxFileBytes: pressure === 'critical' || pressure === 'tight' ? 512 * 1024 : 2 * MiB,
      staleDays: overrides.staleIndexDays ?? Math.max(7, Math.round(60 * factor)),
      // Roughly how large the database gets per byte of indexed text.
      overheadFactor: 3.5,
    },
    checkpoints: {
      keepPerWorkspace: keepCheckpoints,
      maxAgeDays: checkpointMaxAgeDays,
      // One checkpoint's copy of untracked files: the share spread over the checkpoints kept, with headroom.
      maxBytesEach: Math.round(clamp(share.checkpoints / (keepCheckpoints * 3), 8 * MiB, 256 * MiB)),
      maxFileBytes: pressure === 'critical' ? 2 * MiB : 10 * MiB,
      // Never delete anything younger than this, whatever the pressure: a recent run may still need undoing.
      protectHours: 24,
    },
    runEventDays: overrides.runEventDays ?? Math.max(3, Math.round(30 * factor)),
    logs: { maxBytes: pressure === 'critical' ? 5 * MiB : 25 * MiB, keep: 3 },
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= GiB) return `${(value / GiB).toFixed(value >= 10 * GiB ? 0 : 1)} GB`;
  if (value >= MiB) return `${(value / MiB).toFixed(value >= 100 * MiB ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export { GiB, MiB };
