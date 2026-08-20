#!/usr/bin/env node

import process from 'node:process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ECOSYSTEMS = new Set(['npm', 'cargo', 'playwright', 'apt']);
const FORBIDDEN_COMPONENTS = new Set([
  'node_modules', 'target', '.venv', 'venv',
  '.ssh', '.gnupg', '.aws', '.docker', '.kube', '.config', 'credentials',
]);

function lines(name, value) {
  const entries = String(value ?? '').split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error(`${name} requires at least one path`);
  return entries;
}

function safeToken(name, value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u.test(value ?? '')) {
    throw new Error(`${name} must be an explicit version token`);
  }
  if (/(?:^|[._+-])(?:latest|stable|lts|nightly)(?:$|[._+-])/iu.test(value)) {
    throw new Error(`${name} must be exact, not ${value}`);
  }
  return value.toLowerCase();
}

function isInside(parent, child) {
  const fromParent = relative(parent, child);
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`));
}

function validateCachePaths(root, input, ecosystem, runnerTemp, requirePresent) {
  if (!runnerTemp || !isAbsolute(runnerTemp)) {
    throw new Error('runner-temp must be an absolute trusted runner path');
  }
  const lexicalRoot = resolve(root);
  const lexicalRunnerTemp = resolve(runnerTemp);
  const lexicalTrustedRoot = resolve(lexicalRunnerTemp, 'ci-dependency-cache', ecosystem);
  const realRoot = realpathSync(root);
  const realRunnerTemp = realpathSync(runnerTemp);
  const realTrustedRoot = resolve(realRunnerTemp, 'ci-dependency-cache', ecosystem);
  return lines('cache-paths', input).map((entry) => {
    if (/[*?\[\]{}]/u.test(entry)) throw new Error(`cache path must be literal: ${entry}`);
    const absolute = resolve(entry);
    const canonical = resolve(realRunnerTemp, relative(lexicalRunnerTemp, absolute));
    const normalized = canonical.replaceAll('\\', '/').replace(/\/+$/u, '');
    const components = normalized.split('/').filter(Boolean).map((component) => component.toLowerCase());
    const forbidden = components.find((component) => FORBIDDEN_COMPONENTS.has(component));
    if (forbidden) throw new Error(`cache path contains forbidden component ${forbidden}: ${entry}`);
    if (entry === '/' || /^[A-Za-z]:[\\/]?$/u.test(entry)) {
      throw new Error(`cache path is too broad: ${entry}`);
    }
    if (!isAbsolute(entry)) {
      throw new Error(`cache path must be absolute: ${entry}`);
    }
    if (isInside(lexicalRoot, absolute) || isInside(realRoot, canonical)) {
      throw new Error(`cache path must be outside the repository workspace: ${entry}`);
    }
    if (!isInside(lexicalTrustedRoot, absolute)) {
      throw new Error(`cache path must stay under ${lexicalTrustedRoot}: ${entry}`);
    }
    if (requirePresent && !existsSync(entry)) throw new Error(`cache path was not created: ${entry}`);
    if (existsSync(entry)) {
      const metadata = lstatSync(entry);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`cache path must be a real directory: ${entry}`);
      }
      const realEntry = realpathSync(entry);
      if (!isInside(realTrustedRoot, realEntry)) {
        throw new Error(`cache path resolves outside ${realTrustedRoot}: ${entry}`);
      }
    }
    return normalized;
  });
}

function lockfileEntries(root, input) {
  const realRoot = realpathSync(root);
  return lines('lockfiles', input).map((entry) => {
    if (isAbsolute(entry) || /[*?\[\]{}]/u.test(entry)) {
      throw new Error(`lockfile must be an exact repository-relative path: ${entry}`);
    }
    const absolute = resolve(realRoot, entry);
    if (!isInside(realRoot, absolute)) {
      throw new Error(`lockfile escapes the repository workspace: ${entry}`);
    }
    if (!existsSync(absolute)) throw new Error(`lockfile is not a file: ${entry}`);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`lockfile is not a regular file: ${entry}`);
    }
    const realFile = realpathSync(absolute);
    if (!isInside(realRoot, realFile)) {
      throw new Error(`lockfile resolves outside the repository workspace: ${entry}`);
    }
    return { path: entry.replaceAll('\\', '/'), bytes: readFileSync(realFile) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function frame(digest, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  digest.update(`${label}\0${bytes.length}\0`).update(bytes).update('\0');
}

export function dependencyCacheIdentity({
  root = process.cwd(),
  ecosystem,
  cachePaths,
  lockfiles,
  toolchainVersion,
  runnerOs,
  runnerArch,
  runnerTemp = process.env.RUNNER_TEMP,
  requireCachePaths = false,
}) {
  if (!ECOSYSTEMS.has(ecosystem)) throw new Error(`unsupported cache ecosystem: ${ecosystem}`);
  const os = safeToken('runner-os', runnerOs);
  const arch = safeToken('runner-arch', runnerArch);
  const toolchain = safeToken('toolchain-version', toolchainVersion);
  const paths = validateCachePaths(root, cachePaths, ecosystem, runnerTemp, requireCachePaths);
  const files = lockfileEntries(root, lockfiles);
  const digest = createHash('sha256');
  for (const path of paths.sort()) frame(digest, 'cache-path', path);
  for (const file of files) {
    frame(digest, 'lockfile-path', file.path);
    frame(digest, 'lockfile-bytes', file.bytes);
  }
  return `ci-deps-v1-${os}-${arch}-${ecosystem}-${toolchain}-${digest.digest('hex')}`;
}

async function main() {
  const key = dependencyCacheIdentity({
    root: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    ecosystem: process.env.CACHE_ECOSYSTEM,
    cachePaths: process.env.CACHE_PATHS,
    lockfiles: process.env.CACHE_LOCKFILES,
    toolchainVersion: process.env.CACHE_TOOLCHAIN_VERSION,
    runnerOs: process.env.CACHE_RUNNER_OS,
    runnerArch: process.env.CACHE_RUNNER_ARCH,
    runnerTemp: process.env.CACHE_RUNNER_TEMP,
    requireCachePaths: process.env.CACHE_REQUIRE_PATHS_PRESENT === 'true',
  });
  if (process.env.CACHE_EXPECTED_KEY && key !== process.env.CACHE_EXPECTED_KEY) {
    throw new Error('dependency cache identity changed during installation');
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
  }
  process.stdout.write(`dependency cache identity: ${key}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
