import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = ['react', 'react-dom', 'scheduler', 'lucide-react', 'zod', '@fontsource/geist', '@fontsource/geist-mono'];
export async function frontendNotices(root) {
  root = resolve(root); const require = createRequire(resolve(root, 'package.json'));
  const sources = [];
  for (const name of names) {
    const resolver = name === 'scheduler' ? createRequire(require.resolve('react-dom/package.json')) : require;
    const packagePath = resolver.resolve(name + '/package.json'), packageInfo = JSON.parse(await readFile(packagePath, 'utf8'));
    const licensePath = resolve(dirname(packagePath), 'LICENSE'), bytes = await readFile(licensePath);
    if (packageInfo.name !== name || !packageInfo.version || !packageInfo.license || !bytes.length) throw new Error('Installed dependency license metadata is incomplete');
    sources.push({ name, version: packageInfo.version, declaredLicense: packageInfo.license, source: relative(root, licensePath).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') });
  }
  const heading = 'PATCHWORK CONSTELLATION — THIRD-PARTY NOTICES\n\nRepository code is licensed under Apache-2.0. The following distributed dependencies\nretain their original licenses and copyright notices. License bodies below are copied\nverbatim from the installed registry packages used by the frozen-lockfile build.\nFonts remain under the SIL Open Font License 1.1; they are not relicensed as Apache-2.0.\nServer dependencies installed separately retain the license files in their own packages.\n';
  const text = heading + sources.map(({ name, version, declaredLicense, source, sha256, text }) => `\n${'='.repeat(78)}\nPackage: ${name}\nVersion: ${version}\nPackage-declared license: ${declaredLicense}\nInstalled license source: ${source}\nLicense-source SHA-256: ${sha256}\n${'-'.repeat(78)}\n\n${text}${text.endsWith('\n') ? '' : '\n'}`).join('');
  const provenance = { schemaVersion: '1', noticeSha256: createHash('sha256').update(text).digest('hex'), packages: sources.map(({ text: _text, ...source }) => source) };
  return { text, provenance: JSON.stringify(provenance, null, 2) + '\n' };
}
export async function checkFrontendNotices(root) {
  const generated = await frontendNotices(root), directory = resolve(root, 'apps/web/public');
  if (await readFile(resolve(directory, 'THIRD_PARTY_NOTICES.txt'), 'utf8') !== generated.text || await readFile(resolve(directory, 'THIRD_PARTY_NOTICES.json'), 'utf8') !== generated.provenance) throw new Error('Frontend dependency notices are missing or stale');
  return generated;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    if (process.argv.includes('--check')) await checkFrontendNotices(root);
    else { const generated = await frontendNotices(root); const directory = resolve(root, 'apps/web/public'); await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, 'THIRD_PARTY_NOTICES.txt'), generated.text); await writeFile(resolve(directory, 'THIRD_PARTY_NOTICES.json'), generated.provenance); }
    console.log(`Frontend third-party license notices: ${names.length} installed packages ${process.argv.includes('--check') ? 'verified' : 'recorded'}.`);
  } catch { console.error('Frontend notices need review/regeneration from the installed frozen-lockfile packages.'); process.exitCode = 1; }
}
