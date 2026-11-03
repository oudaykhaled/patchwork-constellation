import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const rootFiles = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts', 'LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', '.env.example', '.gitattributes', '.release/acceptance.json']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const frontendPackages = ['react', 'react-dom', 'scheduler', 'lucide-react', 'zod', '@fontsource/geist', '@fontsource/geist-mono'];
export function thirdPartyNoticeRecord(text, provenance) {
  if (!text || !provenance) throw new Error('Frontend third-party notices are required');
  const metadata = JSON.parse(provenance.toString('utf8'));
  if (metadata.schemaVersion !== '1' || metadata.noticeSha256 !== sha256(text) || !Array.isArray(metadata.packages) || metadata.packages.length !== frontendPackages.length || new Set(metadata.packages.map(pkg => pkg.name)).size !== frontendPackages.length || frontendPackages.some(name => !metadata.packages.some(pkg => pkg.name === name)) || !text.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error('Frontend third-party license provenance is invalid');
  for (const pkg of metadata.packages) if (typeof pkg.version !== 'string' || !pkg.version || typeof pkg.declaredLicense !== 'string' || !/^[a-f0-9]{64}$/.test(pkg.sha256)) throw new Error('Invalid dependency license provenance');
  return { path: 'dist/THIRD_PARTY_NOTICES.txt', metadataPath: 'dist/THIRD_PARTY_NOTICES.json', sha256: sha256(text), packages: metadata.packages.map(({ name, version, declaredLicense }) => ({ name, version, declaredLicense })) };
}
export function safeReleasePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) || /[\x00-\x1f\x7f:]/.test(path)) throw new Error('Unsafe release path');
  if (/(?:^|\/)(?:node_modules|\.git|\.cache|\.tmp)(?:\/|$)/.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example' || /\.(?:pem|key|p12|pfx)$/i.test(path)) throw new Error('Private or generated source path excluded from release');
  return path;
}
export function inspectReleaseArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 110_000_000 }); const entries = []; const seen = new Set(); let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const path = safeReleasePath([text(345, 155), text(0, 100)].filter(Boolean).join('/'));
    if (seen.has(path) || !['0', ''].includes(text(156, 1))) throw new Error('Archive supports unique regular files only'); seen.add(path);
    const sizeText = text(124, 12).trim(); if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid archive size'); const size = Number.parseInt(sizeText, 8);
    if (size > 100_000_000 || size < 0 || offset + 512 + size > tar.length || entries.length >= 5000) throw new Error('Archive exceeds bounds');
    const copy = Buffer.from(header); copy.fill(32, 148, 156); const checksum = Number.parseInt(text(148, 8).trim(), 8); if (copy.reduce((sum, byte) => sum + byte, 0) !== checksum) throw new Error('Invalid archive header');
    entries.push({ path, bytes: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)) }); offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!entries.some(entry => entry.path === 'release-manifest.json')) throw new Error('Archive manifest missing'); return entries;
}
export async function extractReleaseArchive(bytes, directory) {
  const root = resolve(directory); const entries = inspectReleaseArchive(bytes);
  const manifest = JSON.parse(entries.find(entry => entry.path === 'release-manifest.json').bytes.toString('utf8'));
  if (manifest.schemaVersion !== '1' || !Array.isArray(manifest.files) || manifest.files.length > 5000 || entries.length !== manifest.files.length + 1) throw new Error('Archive and manifest entries differ');
  const expected = new Set(manifest.files.map(file => safeReleasePath(file.path))); if (expected.size !== manifest.files.length || expected.has('release-manifest.json') || entries.some(entry => entry.path !== 'release-manifest.json' && !expected.has(entry.path))) throw new Error('Archive has undeclared entries');
  await mkdir(root, { recursive: false });
  for (const entry of entries) { const path = resolve(root, entry.path); if (!path.startsWith(root + sep)) throw new Error('Unsafe archive target'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, entry.bytes, { flag: 'wx' }); }
  return verifyRelease(root);
}
function sourceFile(path) { return rootFiles.has(path) || /^(?:apps|packages|database|scripts|docs|planning|tests|tools|\.github)\//.test(path); }
function tarEntry(name, bytes, epoch) {
  safeReleasePath(name); const header = Buffer.alloc(512); const encoded = Buffer.from(name); let prefix = '', short = name;
  if (encoded.length > 100) { const split = name.lastIndexOf('/'); prefix = name.slice(0, split); short = name.slice(split + 1); if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(short) > 100) throw new Error('Release path exceeds ustar limit'); }
  header.write(short, 0, 100); header.write('0000644\0', 100, 8); header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12); header.write(epoch.toString(8).padStart(11, '0') + '\0', 136, 12); header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
}
export async function verifyRelease(directory) {
  const root = resolve(directory); const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== '1' || !Array.isArray(manifest.files) || manifest.files.length > 5000) throw new Error('Invalid release manifest');
  const seen = new Set();
  for (const file of manifest.files) { safeReleasePath(file.path); if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 100_000_000 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid release file digest'); if (seen.has(file.path)) throw new Error('Duplicate release path'); seen.add(file.path); const absolute = resolve(root, file.path); if (!absolute.startsWith(root + sep) || !(await lstat(absolute)).isFile()) throw new Error('Release entry must be a regular file'); const bytes = await readFile(absolute); if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Release integrity check failed'); }
  if (manifest.files.some(file => /\.woff2?$/.test(file.path)) || manifest.thirdPartyNotices) {
    if (!seen.has('dist/THIRD_PARTY_NOTICES.txt') || !seen.has('dist/THIRD_PARTY_NOTICES.json')) throw new Error('Distributed fonts require their accompanying license notices');
    const notices = thirdPartyNoticeRecord(await readFile(resolve(root, 'dist/THIRD_PARTY_NOTICES.txt')), await readFile(resolve(root, 'dist/THIRD_PARTY_NOTICES.json'))); if (JSON.stringify(notices) !== JSON.stringify(manifest.thirdPartyNotices)) throw new Error('Release third-party license manifest differs');
  }
  return { id: manifest.id, commit: manifest.commit, mode: manifest.mode, files: seen.size, thirdPartyNotices: manifest.thirdPartyNotices };
}
export async function createRelease(root, outputDirectory = resolve(root, 'release-artifacts'), { allowDirty = false } = {}) {
  root = resolve(root); const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const dirty = Boolean(git(['status', '--porcelain', '--untracked-files=normal'])); if (dirty && !allowDirty) throw new Error('Commit the release source first; dirty artifacts cannot be promoted');
  const commit = git(['rev-parse', 'HEAD']); const epoch = Number(git(['show', '-s', '--format=%ct', 'HEAD'])); const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (pkg.license !== 'Apache-2.0' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Release requires version and owner-approved license');
  const id = `patchwork-constellation-${pkg.version}-${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`; const files = new Map();
  const paths = git(['ls-files', '-z']).split('\0').filter(Boolean).filter(sourceFile).sort();
  for (const path of paths) { safeReleasePath(path); const absolute = resolve(root, path); if (!(await lstat(absolute)).isFile()) throw new Error('Release source must be regular files, without symlinks'); files.set(path, await readFile(absolute)); }
  async function assets(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const absolute = resolve(directory, entry.name); if (entry.isDirectory()) await assets(absolute); else if (entry.isFile()) files.set(safeReleasePath(relative(root, absolute).split(sep).join('/')), await readFile(absolute)); else throw new Error('Build assets cannot contain symlinks'); } }
  await assets(resolve(root, 'dist')); if (!files.has('dist/index.html') || !files.has('LICENSE')) throw new Error('Build and license are required');
  const thirdPartyNotices = thirdPartyNoticeRecord(files.get('dist/THIRD_PARTY_NOTICES.txt'), files.get('dist/THIRD_PARTY_NOTICES.json'));
  if (!files.get('apps/web/public/THIRD_PARTY_NOTICES.txt')?.equals(files.get('dist/THIRD_PARTY_NOTICES.txt')) || !files.get('apps/web/public/THIRD_PARTY_NOTICES.json')?.equals(files.get('dist/THIRD_PARTY_NOTICES.json'))) throw new Error('Built and source third-party notices differ');
  const sorted = [...files].sort(([a], [b]) => a.localeCompare(b, 'en')); if (sorted.length > 5000 || sorted.reduce((sum, [, bytes]) => sum + bytes.length, 0) > 100_000_000) throw new Error('Release exceeds bounded artifact size');
  const manifest = { schemaVersion: '1', id, version: pkg.version, commit, sourceEpoch: epoch, dirty, mode: 'deterministic-preview', license: pkg.license, node: pkg.engines.node, packageManager: pkg.packageManager, files: sorted.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
  manifest.thirdPartyNotices = thirdPartyNotices;
  files.set('release-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  const tar = []; for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) tar.push(...tarEntry(path, bytes, epoch)); tar.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(tar), { level: 9 }); const output = resolve(outputDirectory, `${id}.tar.gz`); await mkdir(dirname(output), { recursive: true }); await writeFile(output, archive); await writeFile(`${output}.sha256`, `${sha256(archive)}  ${id}.tar.gz\n`); await writeFile(resolve(outputDirectory, `${id}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  return { id, commit, dirty, archive: output, sha256: sha256(archive), files: files.size, bytes: archive.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = process.argv[2] === 'verify' ? await verifyRelease(process.argv[3] || '.') : await createRelease(process.cwd(), process.env.RELEASE_OUT_DIR, { allowDirty: process.argv.includes('--allow-dirty') }); console.log(JSON.stringify(result, null, 2)); }
  catch { console.error('Release packaging or integrity verification failed. Use a committed checkout, built frontend, safe regular files and the documented license.'); process.exitCode = 1; }
}
