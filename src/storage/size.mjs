import fsp from 'node:fs/promises';
import path from 'node:path';

/** Total bytes under a directory. Symlinks are counted as links, never followed, so a stray one cannot send this elsewhere. */
export async function directorySize(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  // Each branch returns its own number and they are summed afterwards: `total += await …` inside concurrent callbacks
  // reads `total` before the await and loses every other update.
  const sizes = await Promise.all(entries.map(async (entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return directorySize(full);
    return (await fsp.lstat(full).catch(() => null))?.size || 0;
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function fileSize(file) {
  return (await fsp.stat(file).catch(() => null))?.size || 0;
}
