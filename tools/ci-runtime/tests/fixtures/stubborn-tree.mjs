import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, pidFile] = process.argv.slice(2);
process.on('SIGTERM', () => {});

if (mode === 'parent') {
  spawn(process.execPath, [new URL(import.meta.url).pathname, 'child', pidFile], {
    detached: false,
    stdio: 'ignore',
  });
} else {
  appendFileSync(pidFile, `${process.pid}\n`);
}

setInterval(() => {}, 1_000);
