#!/usr/bin/env node

import process from 'node:process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAPPING_KEY = /^(\s*)(?:(["'])([A-Za-z0-9_-]+)\2|([A-Za-z0-9_-]+)):\s*(.*)$/u;
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

function mappingLine(line) {
  const match = MAPPING_KEY.exec(line);
  if (!match) return null;
  return {
    indent: match[1].length,
    key: match[3] ?? match[4],
    value: match[5],
  };
}

function emptyMappingValue(value) {
  return /^(?:#.*)?$/u.test(value.trim());
}

function jobBlocks(lines) {
  const jobsLine = lines.findIndex((line) => {
    const mapping = mappingLine(line);
    return mapping?.key === 'jobs' && emptyMappingValue(mapping.value);
  });
  if (jobsLine < 0) return [];
  const jobsIndent = mappingLine(lines[jobsLine]).indent;
  let end = lines.length;
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (/^\s*/u.exec(line)[0].length <= jobsIndent) {
      end = index;
      break;
    }
  }
  const jobIndent = lines.slice(jobsLine + 1, end)
    .map(mappingLine)
    .filter((mapping) => mapping && mapping.indent > jobsIndent && emptyMappingValue(mapping.value))
    .reduce((minimum, mapping) => Math.min(minimum, mapping.indent), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(jobIndent)) return [];
  const blocks = [];
  let current;
  for (let index = jobsLine + 1; index < end; index += 1) {
    const line = lines[index];
    const mapping = mappingLine(line);
    if (mapping?.indent === jobIndent && emptyMappingValue(mapping.value)) {
      if (current) blocks.push(current);
      current = { name: mapping.key, line: index + 1, indent: jobIndent, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function directJobFields(job) {
  const mappings = job.lines.slice(1)
    .map(mappingLine)
    .filter((mapping) => mapping && mapping.indent > job.indent);
  const fieldIndent = mappings.reduce(
    (minimum, mapping) => Math.min(minimum, mapping.indent),
    Number.POSITIVE_INFINITY,
  );
  return mappings.filter((mapping) => mapping.indent === fieldIndent);
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

function durationSeconds(value, unit = '') {
  return Number(value) * { '': 1, s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
}

function parsedDuration(token) {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/u.exec(token);
  if (!match) return null;
  const seconds = durationSeconds(match[1], match[2]);
  return Number.isFinite(seconds) ? seconds : null;
}

function timeoutDeadlineSeconds(prefix) {
  const tokens = prefix.trim().split(/\s+/u);
  if (tokens.shift() !== 'timeout') return null;
  while (tokens.length) {
    const token = tokens.shift();
    if (token === '--') return tokens.length ? parsedDuration(tokens[0]) : null;
    if (['--foreground', '--preserve-status', '--verbose', '-v'].includes(token)) continue;
    if (['--kill-after', '-k'].includes(token)) {
      if (!tokens.length || parsedDuration(tokens.shift()) === null) return null;
      continue;
    }
    if (['--signal', '-s'].includes(token)) {
      if (!tokens.shift()) return null;
      continue;
    }
    if (token.startsWith('--kill-after=')) {
      if (parsedDuration(token.slice('--kill-after='.length)) === null) return null;
      continue;
    }
    if (token.startsWith('--signal=')) {
      if (!token.slice('--signal='.length)) return null;
      continue;
    }
    if (/^-k.+/u.test(token)) {
      if (parsedDuration(token.slice(2)) === null) return null;
      continue;
    }
    if (/^-s.+/u.test(token)) continue;
    if (token.startsWith('-')) return null;
    return parsedDuration(token);
  }
  return null;
}

function logicalShellCommands(segment) {
  const commands = [];
  let current;
  for (const entry of segment) {
    const trailingBackslashes = /\\+$/u.exec(entry.text)?.[0].length ?? 0;
    const continued = trailingBackslashes % 2 === 1;
    const text = continued ? entry.text.slice(0, -1) : entry.text;
    if (current) {
      current.text += text.trimStart();
    } else {
      current = { line: entry.line, text };
    }
    if (continued) {
      current.text += ' ';
    } else {
      commands.push(current);
      current = undefined;
    }
  }
  if (current) commands.push(current);
  return commands;
}

function enforcedException(segment, installerText) {
  const exception = segment.map(({ text }) => EXCEPTION.exec(text)).find(Boolean);
  if (!exception) return false;
  const command = installerText.trim();
  const installerIndex = INSTALLERS.map((pattern) => command.search(pattern))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (!/^timeout(?:\s|$)/u.test(command)) return false;
  const timeoutPrefix = command.slice(0, installerIndex);
  if (/[;&|]/u.test(timeoutPrefix)) return false;
  const actualSeconds = timeoutDeadlineSeconds(timeoutPrefix);
  if (actualSeconds === null) return false;
  const [, maximumValue, maximumUnit] = exception;
  return actualSeconds <= durationSeconds(maximumValue, maximumUnit);
}

function installerFinding(segment) {
  for (const { line, text } of logicalShellCommands(segment)) {
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
    const fields = directJobFields(job);
    if (!fields.some(({ key }) => key === 'runs-on')) continue;
    const timeout = fields.find(({ key }) => key === 'timeout-minutes');
    if (!timeout) {
      findings.push({ file, line: job.line, message: `runner job ${job.name} has no timeout-minutes` });
      continue;
    }
    const literal = /^(\d+)\s*(?:#.*)?$/u.exec(timeout.value);
    const minutes = literal ? Number(literal[1]) : Number.NaN;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 360) {
      findings.push({
        file,
        line: job.line,
        message: `runner job ${job.name} timeout-minutes must be a literal integer between 1 and 360`,
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

export function parseRootArgument(args, { cwd = process.cwd() } = {}) {
  const rootIndex = args.indexOf('--root');
  if (rootIndex < 0) return cwd;
  const value = args[rootIndex + 1];
  if (!value || value.startsWith('--')) throw new Error('--root requires a path');
  return resolve(cwd, value);
}

async function main() {
  const root = parseRootArgument(process.argv.slice(2));
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
