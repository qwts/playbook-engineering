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
const BOUNDED_ACTION = /\.github\/actions\/bounded-(?:command|dependency-install)(?:@\S+)?$/u;
// ENG-0269: the job timeout must enclose the complete installer retry and
// termination budget plus at least one minute for checkout, setup, cache
// custody checks, save, and the job's own work.
const ENVELOPE_HEADROOM_SECONDS = 60;
const ENVELOPE_DEFAULTS = { attempts: 1, 'retry-delay-seconds': 0, 'termination-grace-seconds': 10 };

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

function stepBlocks(job) {
  const stepsIndex = job.lines.findIndex((line) => {
    const mapping = mappingLine(line);
    return mapping && mapping.indent > job.indent && mapping.key === 'steps'
      && emptyMappingValue(mapping.value);
  });
  if (stepsIndex < 0) return [];
  const stepsIndent = mappingLine(job.lines[stepsIndex]).indent;
  const steps = [];
  let current;
  let itemIndent = null;
  for (let index = stepsIndex + 1; index < job.lines.length; index += 1) {
    const raw = job.lines[index];
    if (!raw.trim() || /^\s*#/u.test(raw)) continue;
    if (/^\s*/u.exec(raw)[0].length <= stepsIndent) break;
    const item = /^(\s*)-(?:\s|$)/u.exec(raw);
    if (item && (itemIndent === null || item[1].length === itemIndent)) {
      itemIndent = item[1].length;
      if (current) steps.push(current);
      // Blank the list dash so field indentation stays column-accurate.
      current = { line: job.line + index, lines: [raw.replace(/^(\s*)-/u, '$1 ')] };
    } else if (current) {
      current.lines.push(raw);
    }
  }
  if (current) steps.push(current);
  return steps;
}

function stepMappings(step) {
  return step.lines
    .map((line, index) => {
      const mapping = mappingLine(line);
      return mapping && { ...mapping, line: step.line + index };
    })
    .filter(Boolean);
}

function literalInteger(value) {
  const match = /^(["']?)(\d+)\1\s*(?:#.*)?$/u.exec(value.trim());
  return match ? Number(match[2]) : null;
}

function stepFields(step) {
  const mappings = stepMappings(step);
  if (!mappings.length) return { mappings: [], fields: [] };
  const fieldIndent = mappings.reduce(
    (minimum, { indent }) => Math.min(minimum, indent),
    Number.POSITIVE_INFINITY,
  );
  return { mappings, fields: mappings.filter(({ indent }) => indent === fieldIndent) };
}

function usesReference(value) {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*?)\1/u.exec(trimmed);
  return quoted ? quoted[2] : trimmed.replace(/\s+#.*$/u, '');
}

function boundedEnvelope(step) {
  const { mappings, fields } = stepFields(step);
  const uses = fields.find(({ key }) => key === 'uses');
  if (!uses || !BOUNDED_ACTION.test(usesReference(uses.value))) return null;
  const withField = fields.find(({ key }) => key === 'with');
  const withEnd = mappings.indexOf(withField) < 0
    ? -1
    : mappings.findIndex((mapping, index) => index > mappings.indexOf(withField) && mapping.indent <= withField.indent);
  const withEntries = withField
    ? mappings.slice(mappings.indexOf(withField) + 1, withEnd < 0 ? mappings.length : withEnd)
    : [];
  const inputs = {};
  for (const key of ['timeout-seconds', 'attempts', 'retry-delay-seconds', 'termination-grace-seconds']) {
    const entry = withEntries.find((candidate) => candidate.key === key);
    if (!entry) {
      inputs[key] = key in ENVELOPE_DEFAULTS ? ENVELOPE_DEFAULTS[key] : null;
      continue;
    }
    inputs[key] = literalInteger(entry.value);
  }
  return { line: uses.line, inputs };
}

function envelopeWorstCaseSeconds({ inputs }) {
  const attempts = inputs.attempts;
  return attempts * (inputs['timeout-seconds'] + inputs['termination-grace-seconds'])
    + (attempts - 1) * inputs['retry-delay-seconds'];
}

function envelopeFindings(job, jobTimeoutMinutes, file) {
  const envelopes = [];
  const invalidEnvelopes = [];
  const opaqueStepTimeouts = [];
  let stepBoundSeconds = 0;
  for (const step of stepBlocks(job)) {
    const envelope = boundedEnvelope(step);
    if (envelope) {
      const invalid = Object.keys(envelope.inputs).filter((key) => envelope.inputs[key] === null);
      if (invalid.length) {
        invalidEnvelopes.push({ line: envelope.line, keys: invalid });
      } else {
        envelopes.push(envelope);
      }
      continue;
    }
    const timeout = stepFields(step).fields.find(({ key }) => key === 'timeout-minutes');
    if (!timeout) continue;
    const minutes = literalInteger(timeout.value);
    if (minutes === null) {
      opaqueStepTimeouts.push(timeout);
    } else {
      stepBoundSeconds += minutes * 60;
    }
  }
  if (!envelopes.length && !invalidEnvelopes.length) return [];
  const findings = invalidEnvelopes.map(({ line, keys }) => ({
    file,
    line,
    message: `runner job ${job.name} bounded envelope needs literal integer ${keys.join(', ')}`,
  }));
  findings.push(...opaqueStepTimeouts.map(({ line }) => ({
    file,
    line,
    message: `runner job ${job.name} bounded-step arithmetic needs a literal step timeout-minutes`,
  })));
  if (findings.length) return findings;
  const worstCaseSeconds = envelopes.reduce(
    (total, envelope) => total + envelopeWorstCaseSeconds(envelope),
    stepBoundSeconds,
  );
  const budgetSeconds = jobTimeoutMinutes * 60;
  if (worstCaseSeconds + ENVELOPE_HEADROOM_SECONDS > budgetSeconds) {
    findings.push({
      file,
      line: envelopes[0].line,
      message: `runner job ${job.name} bounded steps can exceed the job budget: `
        + `worst case ${worstCaseSeconds}s plus ${ENVELOPE_HEADROOM_SECONDS}s headroom `
        + `> timeout-minutes ${jobTimeoutMinutes} (${budgetSeconds}s)`,
    });
  }
  return findings;
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

function parsedDeadline(token) {
  const seconds = parsedDuration(token);
  return seconds !== null && seconds > 0 ? seconds : null;
}

function timeoutDeadlineSeconds(prefix) {
  const tokens = prefix.trim().split(/\s+/u);
  if (tokens.shift() !== 'timeout') return null;
  while (tokens.length) {
    const token = tokens.shift();
    if (token === '--') return tokens.length ? parsedDeadline(tokens[0]) : null;
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
    return parsedDeadline(token);
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
      continue;
    }
    findings.push(...envelopeFindings(job, minutes, file));
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
