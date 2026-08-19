#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { ESLint } from 'eslint';
import globals from 'globals';

import { GOVERNED_HARNESS_FILES } from './lib/baseline-files.mjs';

const NODE_ESLINT_CONFIG = {
  ...js.configs.recommended,
  files: ['**/*.mjs'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: globals.nodeBuiltin,
  },
  rules: {
    ...js.configs.recommended.rules,
    'no-undef': 'error',
    'no-unused-vars': 'error',
  },
};

function commandFailure(pathname, command, result) {
  if (result.error) {
    return `${pathname}: could not run ${command} - ${result.error.message}`;
  }
  const detail = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  return `${pathname}: ${command} -n failed${detail ? `\n${detail}` : ''}`;
}

function checkShellSyntax(pathname, absolute, command, spawn = spawnSync) {
  const result = spawn(command, ['-n', absolute], { encoding: 'utf8' });
  return result.status === 0 ? null : commandFailure(pathname, command, result);
}

function zshIsMissing(result) {
  return result.error?.code === 'ENOENT';
}

export async function lintSyncedFiles({
  root = process.cwd(),
  paths = GOVERNED_HARNESS_FILES,
  spawn = spawnSync,
} = {}) {
  const diagnostics = [];
  const present = [];

  for (const pathname of paths) {
    try {
      await access(path.join(root, pathname));
      present.push(pathname);
    } catch (error) {
      diagnostics.push(`${pathname}: governed file is missing (${error.message})`);
    }
  }

  const modules = present.filter((pathname) => pathname.endsWith('.mjs'));
  if (modules.length) {
    const eslint = new ESLint({
      cwd: root,
      ignore: false,
      overrideConfigFile: true,
      overrideConfig: [NODE_ESLINT_CONFIG],
    });
    const results = await eslint.lintFiles(modules);
    const failures = results.filter((result) => result.errorCount > 0);
    if (failures.length) {
      const formatter = await eslint.loadFormatter('stylish');
      diagnostics.push((await formatter.format(failures)).trim());
    }
  }

  for (const pathname of present.filter((candidate) => candidate.endsWith('.json'))) {
    try {
      JSON.parse(await readFile(path.join(root, pathname), 'utf8'));
    } catch (error) {
      diagnostics.push(`${pathname}: invalid JSON - ${error.message}`);
    }
  }

  for (const pathname of present.filter((candidate) => candidate.endsWith('.sh'))) {
    const diagnostic = checkShellSyntax(pathname, path.join(root, pathname), 'bash', spawn);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  for (const pathname of present.filter((candidate) => candidate.endsWith('.zsh'))) {
    const absolute = path.join(root, pathname);
    const result = spawn('zsh', ['-n', absolute], { encoding: 'utf8' });
    if (result.status !== 0 && !zshIsMissing(result)) {
      diagnostics.push(commandFailure(pathname, 'zsh', result));
    }
  }

  return {
    errorCount: diagnostics.length,
    output: diagnostics.join('\n\n'),
  };
}

async function main() {
  const result = await lintSyncedFiles();
  if (result.errorCount) {
    process.stderr.write(`${result.output}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Validated ${GOVERNED_HARNESS_FILES.length} governed harness files.\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
