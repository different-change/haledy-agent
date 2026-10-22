import { cp, mkdir, readdir, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('Invalid output path');
await mkdir(dist, { recursive: true });
// Keep the output directory itself alive: the Windows preview watcher holds it open.
async function clearFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await clearFiles(filename);
    else await rm(filename);
  }
}
await clearFiles(dist);
await cp(path.join(root, 'public'), dist, { recursive: true });
// Terms that must never ship (the founder's own plan and identifiers) live in an untracked
// file, so this public repository does not publish the very strings it guards against.
let privateTerms = [];
try {
  privateTerms = (await readFile(path.join(root, '.private-terms'), 'utf8')).split(/\r?\n/).map(t => t.trim()).filter(Boolean);
} catch { /* absent on other machines: the generic checks below still run */ }
const escapeTerm = term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forbidden = new RegExp(['sk-ant-', ...privateTerms.map(escapeTerm)].join('|'), 'i');
let total = 0;
async function validate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { await validate(filename); continue; }
    if (!/\.(html|css|js|svg|woff2|txt|png|webp)$/.test(entry.name) && entry.name !== '_headers') throw new Error(`Unexpected deploy file: ${entry.name}`);
    if (/handoff|transcript|AGENTS|CLAUDE|\.env|\.dev\.vars|\.zip/i.test(entry.name)) throw new Error('Private source included');
    const info = await stat(filename); total += info.size;
    if (filename.endsWith('.woff2')) {
      const bytes = await readFile(filename);
      if (bytes.subarray(0, 4).toString() !== 'wOF2') throw new Error(`Invalid WOFF2 asset: ${entry.name}`);
    }
    if (/\.(html|css|js)$/.test(filename)) {
      const source = await readFile(filename, 'utf8');
      // The founder's own plan and identifiers never ship; the demo persona is fictional.
      if (forbidden.test(source)) throw new Error(`Private content in output: ${entry.name}`);
    }
  }
}
await validate(dist);
console.log(`Built Haledy agent: ${(total / 1024).toFixed(1)} KB. Only public/ is deployed.`);
