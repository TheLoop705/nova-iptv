import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] || 'dist');
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const bundle = html.match(/src="(\/_expo\/static\/js\/web\/[^"?]+\.js)"/)?.[1];
if (!bundle) throw new Error('Could not find the exported web entry bundle');
writeFileSync(resolve(dist, 'version.json'), JSON.stringify({ version: config.expo.version, bundle }) + '\n');
console.log(`Published web update manifest for Nova ${config.expo.version}`);
