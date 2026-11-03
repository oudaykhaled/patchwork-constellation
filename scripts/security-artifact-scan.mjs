import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  /CONSTELLATION_PRIVATE_(?:SOURCE|CREDENTIAL)_SENTINEL/,
];
let scanned = 0, bytes = 0, violations = 0;
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Artifact scan refuses symlinks.');
    if (entry.isDirectory()) { await scan(child); continue; }
    if (!['.js', '.map', '.json', '.html', '.css', '.svg'].includes(extname(child))) continue;
    const size = (await stat(child)).size;
    if (size > 20_000_000 || bytes + size > 100_000_000) throw new Error('Artifact scan byte budget exceeded.');
    const text = await readFile(child, 'utf8'); bytes += size; scanned++;
    if (patterns.some(pattern => pattern.test(text))) violations++;
  }
}
try {
  await scan(root);
  console.log(JSON.stringify({ scanned, bytes, violations }));
  if (!scanned || violations) process.exitCode = 1;
} catch { console.error('Artifact scan could not complete safely.'); process.exitCode = 1; }
