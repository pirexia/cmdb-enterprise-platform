import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let commit = process.env.GIT_COMMIT || 'unknown';
if (!commit || commit === 'unknown') {
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  } catch { /* outside git */ }
}

// Prefer GIT_TAG env (injected at Docker build time), then git describe, then package.json
let version = process.env.GIT_TAG || 'unknown';
if (!version || version === 'unknown') {
  try {
    version = execSync('git describe --tags --always', { cwd: root }).toString().trim();
  } catch { /* outside git */ }
}
if (!version || version === 'unknown') {
  version = pkg.version;
}
// Normalize: strip leading 'v' for display consistency
version = version.replace(/^v/, '');

const payload = {
  version,
  commit,
  buildDate: new Date().toISOString(),
};

writeFileSync(join(root, 'public', 'version.json'), JSON.stringify(payload, null, 2));
console.log('[gen-version] wrote public/version.json →', payload);
