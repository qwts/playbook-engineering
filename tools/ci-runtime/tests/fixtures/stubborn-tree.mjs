import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, pidFile] = process.argv.slice(2);
process.on('SIGTERM', () => {});

if (mode === 'parent' || mode === 'detached-parent') {
  spawn(process.execPath, [new URL(import.meta.url).pathname, 'child', pidFile], {
    detached: mode === 'detached-parent',
    stdio: 'ignore',
  }).unref();
} else {
  appendFileSync(pidFile, `${process.pid}\n`);
}

setInterval(() => {}, 1_000);
