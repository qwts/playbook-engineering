#!/usr/bin/env node

import process from 'node:process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const JOB_KEY = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/u;
const RUNNER = /^    runs-on:\s*\S+/mu;
const TIMEOUT = /^    timeout-minutes:\s*(\d+)\s*(?:#.*)?$/mu;
const INSTALLERS = [
  /\bapt-get\s+(?:update|install)\b/u,
  /\bplaywright\s+install\b/u,
  /\bnpm(?:\s+--prefix\s+\S+)?\s+(?:ci|install|clean-install)\b/u,
  /\bpnpm\s+install\b/u,
  /\byarn\s+install\b/u,
  /\bpip(?:3)?\s+install\b/u,
  /\bcargo\s+install\b/u,
  /\bbrew\s+install\b/u,
  /\bgo\s+install\b/u,
];
const EXCEPTION = /#\s*ci-runtime:\s*exception\s+owner=\S+\s+max=(\d+)([smh])\s+review=\S+\s+reason=\S.+$/u;

function workflowFiles(root) {
  const directory = join(root, '.github', 'workflows');
  let names = [];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => join(directory, name));
}

function jobBlocks(lines) {
  const jobsLine = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsLine < 0) return [];
  const blocks = [];
  let current;
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/u.test(line) && !/^\s*#/u.test(line)) break;
    const match = JOB_KEY.exec(line);
    if (match) {
      if (current) blocks.push(current);
      current = { name: match[1], line: index + 1, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function runSegments(lines) {
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-?\s*run:\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[2];
    const segment = [{ line: index + 1, text: inline }];
    if (/^[>|][-+]?\s*(?:#.*)?$/u.test(inline)) {
      let cursor = index + 1;
      while (cursor < lines.length) {
        const candidate = lines[cursor];
        const candidateIndent = /^\s*/u.exec(candidate)[0].length;
        if (candidate.trim() && candidateIndent <= indent) break;
        segment.push({ line: cursor + 1, text: candidate });
        cursor += 1;
      }
      index = cursor - 1;
    }
    segments.push(segment);
  }
  return segments;
}

function durationSeconds(value, unit) {
  return Number(value) * { s: 1, m: 60, h: 3_600 }[unit];
}

function enforcedException(segment, installerText) {
  const exception = segment.map(({ text }) => EXCEPTION.exec(text)).find(Boolean);
  if (!exception) return false;
  const installerIndex = INSTALLERS.map((pattern) => installerText.search(pattern))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const timeoutIndex = installerText.search(/\btimeout\b/u);
  if (timeoutIndex < 0 || timeoutIndex > installerIndex) return false;
  const durations = [...installerText.slice(timeoutIndex, installerIndex).matchAll(/\b(\d+)([smh])\b/gu)];
  if (!durations.length) return false;
  const [, actualValue, actualUnit] = durations.at(-1);
  const [, maximumValue, maximumUnit] = exception;
  return durationSeconds(actualValue, actualUnit) <= durationSeconds(maximumValue, maximumUnit);
}

function installerFinding(segment) {
  for (const { line, text } of segment) {
    if (INSTALLERS.some((pattern) => pattern.test(text)) && !enforcedException(segment, text)) {
      return { line, command: text.trim() };
    }
  }
  return null;
}

export function inspectWorkflow(text, { file = '<workflow>' } = {}) {
  const lines = text.split('\n');
  const findings = [];
  for (const job of jobBlocks(lines)) {
    const body = job.lines.join('\n');
    if (!RUNNER.test(body)) continue;
    const timeout = TIMEOUT.exec(body);
    if (!timeout) {
      findings.push({ file, line: job.line, message: `runner job ${job.name} has no timeout-minutes` });
      continue;
    }
    const minutes = Number(timeout[1]);
    if (minutes < 1 || minutes > 360) {
      findings.push({
        file,
        line: job.line,
        message: `runner job ${job.name} timeout-minutes must be a literal between 1 and 360`,
      });
    }
  }
  for (const segment of runSegments(lines)) {
    const finding = installerFinding(segment);
    if (finding) {
      findings.push({
        file,
        line: finding.line,
        message: `raw dependency installer is not task-bounded: ${finding.command}`,
      });
    }
  }
  return findings;
}

export function checkRuntimePolicy({ root = process.cwd() } = {}) {
  const findings = [];
  for (const file of workflowFiles(root)) {
    findings.push(
      ...inspectWorkflow(readFileSync(file, 'utf8'), { file: relative(root, file) }),
    );
  }
  return findings;
}

async function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : process.cwd();
  const findings = checkRuntimePolicy({ root });
  if (!findings.length) {
    process.stdout.write('all workflow runner jobs and dependency installers are bounded\n');
    return;
  }
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line}: ${finding.message}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
