import fs from 'node:fs';
import path from 'node:path';

/** Load apps/api/.env (if present) before anything reads process.env. Real env vars win. */
const file = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}
