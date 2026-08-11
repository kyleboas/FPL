#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const broker = '/usr/local/bin/fpl-fetch-preseason-data';
const result = spawnSync('sudo', ['-n', broker], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.error) {
  console.error(`Preseason broker could not be invoked: ${result.error.message}`);
  console.error('No direct or interactive fallback was attempted. A human must install it once with:');
  console.error('  cd /home/kyle/fpl && sudo ./bin/install-preseason-broker');
  process.exit(1);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  console.error('Preseason broker did not complete; no direct or interactive fallback was attempted.');
  console.error('If it is not installed, a human must run:');
  console.error('  cd /home/kyle/fpl && sudo ./bin/install-preseason-broker');
  process.exit(result.status || 1);
}

if (result.stderr) process.stderr.write(result.stderr);
