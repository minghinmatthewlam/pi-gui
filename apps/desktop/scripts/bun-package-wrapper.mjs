import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT_PACKAGE_JSON = path.resolve(process.cwd(), '../../package.json');
const originalContent = readFileSync(ROOT_PACKAGE_JSON, 'utf8');
const json = JSON.parse(originalContent);

const originalPM = json.packageManager;
json.packageManager = 'bun';

writeFileSync(ROOT_PACKAGE_JSON, JSON.stringify(json, null, 2));

console.log(`Temporarily set packageManager to bun (was ${originalPM})`);

const result = spawnSync(process.argv[2], process.argv.slice(3), { 
  stdio: 'inherit', 
  shell: true,
  env: { ...process.env, npm_config_user_agent: 'bun' }
});

writeFileSync(ROOT_PACKAGE_JSON, originalContent);
console.log(`Restored packageManager to ${originalPM}`);

process.exit(result.status ?? 0);
