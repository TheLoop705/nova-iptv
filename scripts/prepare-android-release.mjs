#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error('GITHUB_RUN_NUMBER must be a positive integer');

const path = new URL('../app.json', import.meta.url);
const config = JSON.parse(readFileSync(path, 'utf8'));
const baseVersion = String(config?.expo?.version ?? '');
if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error(`Expected expo.version to be x.y.z, got ${baseVersion}`);

// A fourth numeric component keeps every master build newer for Nova's numeric version comparator.
const version = `${baseVersion}.${runNumber}`;
const versionCode = 10_000 + runNumber;
config.expo.version = version;
config.expo.android.versionCode = versionCode;
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');

console.log(`Android release ${version} (versionCode ${versionCode})`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nversion_code=${versionCode}\n`);
}
