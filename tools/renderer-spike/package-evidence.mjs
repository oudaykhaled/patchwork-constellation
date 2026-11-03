import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

// Publication packaging only: no decode/re-encode, resizing, or raster editing.
const directory = resolve(process.argv[3] || 'docs/evidence/graph-01');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = join(directory, 'screenshots-manifest.json');
if (process.argv[2] === 'wrap') {
  const files = (await readdir(directory)).filter(name => name.endsWith('.jpg')).sort();
  if (files.length !== 6) throw new Error('Expected exactly six original renderer screenshots');
  const manifest = { schemaVersion: '1', encoding: 'svg-jpeg-envelope-v1', note: 'SVG image elements embed exact original JPEG bytes; no image transformation or re-encoding.', files: [] };
  for (const originalFile of files) {
    const bytes = await readFile(join(directory, originalFile));
    let width, height;
    // Read a baseline/progressive JPEG SOF header without decoding pixels.
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 0xff) throw new Error(`Malformed JPEG marker in ${originalFile}`);
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      const length = bytes.readUInt16BE(offset);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
    if (!width || !height) throw new Error(`Missing JPEG dimensions in ${originalFile}`);
    const svgFile = originalFile.replace(/\.jpg$/, '.svg');
    const envelope = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>Original renderer evidence: ${originalFile}</title><image width="${width}" height="${height}" href="data:image/jpeg;base64,${bytes.toString('base64')}" /></svg>\n`;
    await writeFile(join(directory, svgFile), envelope, 'utf8');
    manifest.files.push({ originalFile, svgFile, width, height, mediaType: 'image/jpeg', originalBytes: bytes.length, originalSha256: hash(bytes) });
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const entry of manifest.files) {
  const envelope = await readFile(join(directory, entry.svgFile), 'utf8');
  const match = envelope.match(/href="data:image\/jpeg;base64,([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error(`Missing JPEG envelope: ${entry.svgFile}`);
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.length !== entry.originalBytes || hash(decoded) !== entry.originalSha256) throw new Error(`Original/decoded mismatch: ${entry.svgFile}`);
  if (!envelope.includes(`viewBox="0 0 ${entry.width} ${entry.height}"`)) throw new Error(`Dimensions mismatch: ${entry.svgFile}`);
  if (process.argv[2] === 'wrap') {
    const original = await readFile(join(directory, entry.originalFile));
    if (!original.equals(decoded)) throw new Error(`Byte comparison failed: ${entry.originalFile}`);
  }
  console.log(`${entry.svgFile}: ${decoded.length} exact bytes, SHA-256 ${hash(decoded)}`);
}
if (process.argv[2] === 'wrap') for (const entry of manifest.files) await unlink(join(directory, entry.originalFile));
console.log(`Verified ${manifest.files.length} lossless evidence envelopes.`);
