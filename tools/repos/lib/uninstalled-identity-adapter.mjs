const UNINSTALLED_REASON = 'uninstalled identity: refuse human-attributed commit or GitHub write; finish durable bootstrap to publish as the bot';

const CONTROL_OPERATORS = new Set([
  '\n', '&', '&&', '(', ')', ';', ';;', ';&', ';;&', '{', '|', '|&', '||', '}',
]);
const REDIRECTION_OPERATORS = new Set([
  '<', '<<', '<<-', '<<<', '<&', '<>', '>', '>&', '>>', '>|',
]);
const GIT_COMMIT_SUBCOMMANDS = new Set([
  'am',
  'cherry-pick',
  'commit',
  'commit-tree',
  'fast-import',
  'filter-branch',
  'merge',
  'notes',
  'pull',
  'rebase',
  'revert',
  'stash',
]);
const INPUT_DERIVED_GIT_AUTHORS = new Set([
  'am',
  'cherry-pick',
  'fast-import',
  'filter-branch',
  'pull',
  'rebase',
]);
const GIT_NON_PUBLISH_SUBCOMMANDS = new Set([
  'add',
  'annotate',
  'apply',
  'archive',
  'bisect',
  'blame',
  'branch',
  'bundle',
  'cat-file',
  'checkout',
  'clean',
  'clone',
  'config',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'difftool',
  'fetch',
  'for-each-ref',
  'format-patch',
  'fsck',
  'gc',
  'grep',
  'help',
  'init',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'mergetool',
  'mv',
  'name-rev',
  'range-diff',
  'read-tree',
  'reflog',
  'remote',
  'request-pull',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'sparse-checkout',
  'status',
  'submodule',
  'switch',
  'tag',
  'update-index',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'whatchanged',
  'worktree',
]);
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const INDIRECT_EXECUTORS = new Set([
  '.', 'eval', 'find', 'parallel', 'source', 'sudo', 'watch', 'xargs',
]);
const GH_READ_SUBCOMMANDS = {
  alias: ['list'],
  attestation: ['download', 'verify'],
  auth: ['status'],
  browse: [''],
  cache: ['list'],
  config: ['get', 'list'],
  gist: ['list', 'view'],
  help: [''],
  issue: ['list', 'status', 'view'],
  label: ['list'],
  org: ['list'],
  pr: ['checks', 'checkout', 'diff', 'list', 'status', 'view'],
  project: ['list', 'view'],
  release: ['download', 'list', 'view'],
  repo: ['list', 'view'],
  ruleset: ['list', 'view'],
  run: ['list', 'view', 'watch'],
  search: ['code', 'commits', 'issues', 'prs', 'repos'],
  secret: ['list'],
  status: [''],
  variable: ['list'],
  workflow: ['list', 'view'],
};

function cloneContext(context = {}) {
  return {
    clearEnv: Boolean(context.clearEnv),
    cwd: context.cwd || '',
    env: { ...(context.env || {}) },
    unset: [...(context.unset || [])],
  };
}

function unsafeScan() {
  return { operations: [], safe: false };
}

function mergeScan(target, source) {
  target.operations.push(...source.operations);
  target.safe = target.safe && source.safe;
  return target;
}

function extractCommand(payload, env = {}) {
  if (typeof env.AGENT_HOOK_TOOL_COMMAND === 'string' && env.AGENT_HOOK_TOOL_COMMAND) {
    return env.AGENT_HOOK_TOOL_COMMAND;
  }
  if (!payload || typeof payload !== 'object') return '';
  return payload.command
    || payload.tool_input?.command
    || payload.toolArgs?.command
    || payload.tool_info?.command_line
    || payload.tool_input?.cmd
    || '';
}

function readDollarParen(text, start) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      if (i >= text.length) return null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '$' && text[i + 1] === '(') {
        depth += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { end: i, value: text.slice(start, i) };
    }
  }
  return null;
}

function readBackticks(text, start) {
  let value = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      if (i + 1 >= text.length) return null;
      value += text[i + 1];
      i += 1;
      continue;
    }
    if (ch === '`') return { end: i, value };
    value += ch;
  }
  return null;
}

function shellLex(command) {
  const text = String(command || '');
  const tokens = [];
  const substitutions = [];
  let value = '';
  let dynamic = false;
  let quote = null;
  let wordStarted = false;

  function finishWord() {
    if (!wordStarted) return;
    tokens.push({ type: 'word', value, dynamic });
    value = '';
    dynamic = false;
    wordStarted = false;
  }

  function addExpansion(i) {
    dynamic = true;
    wordStarted = true;
    if (text[i + 1] === '(' && text[i + 2] !== '(') {
      const nested = readDollarParen(text, i + 2);
      if (!nested) return { end: text.length, safe: false };
      substitutions.push(nested.value);
      return { end: nested.end, safe: true };
    }
    if (text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      return end === -1 ? { end: text.length, safe: false } : { end, safe: true };
    }
    if (text[i + 1] === '(' && text[i + 2] === '(') {
      const end = text.indexOf('))', i + 3);
      return end === -1 ? { end: text.length, safe: false } : { end: end + 1, safe: true };
    }
    if (text[i + 1] === "'") {
      const end = text.indexOf("'", i + 2);
      return end === -1 ? { end: text.length, safe: false } : { end, safe: true };
    }
    if (text[i + 1] === '"') {
      const end = text.indexOf('"', i + 2);
      return end === -1 ? { end: text.length, safe: false } : { end, safe: true };
    }
    if (text[i + 1]) return { end: i + 1, safe: true };
    return { end: i, safe: false };
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined) return { safe: false, substitutions, tokens };
        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          value += next;
          i += 1;
        } else if (next === '\n') {
          i += 1;
        } else {
          value += `\\${next}`;
          i += 1;
        }
        continue;
      }
      if (ch === '$') {
        const expansion = addExpansion(i);
        if (!expansion.safe) return { safe: false, substitutions, tokens };
        i = expansion.end;
        continue;
      }
      if (ch === '`') {
        const nested = readBackticks(text, i + 1);
        if (!nested) return { safe: false, substitutions, tokens };
        substitutions.push(nested.value);
        dynamic = true;
        wordStarted = true;
        i = nested.end;
        continue;
      }
      value += ch;
      continue;
    }

    if (/\s/u.test(ch)) {
      finishWord();
      if (ch === '\n') tokens.push({ type: 'operator', value: '\n' });
      continue;
    }
    if (ch === '#' && !wordStarted) {
      const end = text.indexOf('\n', i + 1);
      if (end === -1) break;
      tokens.push({ type: 'operator', value: '\n' });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return { safe: false, substitutions, tokens };
      wordStarted = true;
      if (next !== '\n') value += next;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const expansion = addExpansion(i);
      if (!expansion.safe) return { safe: false, substitutions, tokens };
      i = expansion.end;
      continue;
    }
    if (ch === '`') {
      const nested = readBackticks(text, i + 1);
      if (!nested) return { safe: false, substitutions, tokens };
      substitutions.push(nested.value);
      dynamic = true;
      wordStarted = true;
      i = nested.end;
      continue;
    }
    if ('*?['.includes(ch)) dynamic = true;

    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    let operator = '';
    if (three === '<<-' || three === '<<<' || three === ';;&') operator = three;
    else if (['&&', '||', '|&', ';;', ';&', '<<', '>>', '<&', '>&', '<>', '>|'].includes(two)) operator = two;
    else if (';&|()<>'.includes(ch)) operator = ch;
    else if (ch === '{' && !wordStarted && /(?:\s|$)/u.test(text[i + 1] || '')) operator = ch;
    else if (ch === '}' && !wordStarted && /(?:\s|;|&|\||$)/u.test(text[i + 1] || '')) operator = ch;
    if (operator) {
      if (REDIRECTION_OPERATORS.has(operator) && wordStarted && /^\d+$/u.test(value) && !dynamic) {
        value = '';
        wordStarted = false;
      } else finishWord();
      tokens.push({ type: 'operator', value: operator });
      i += operator.length - 1;
      continue;
    }
    if (ch === '{' || ch === '}') dynamic = true;
    value += ch;
    wordStarted = true;
  }
  if (quote) return { safe: false, substitutions, tokens };
  finishWord();
  return { safe: true, substitutions, tokens };
}

function commandGroups(tokens) {
  const groups = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === 'operator' && CONTROL_OPERATORS.has(token.value)) {
      if (current.length) groups.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) groups.push(current);
  return groups;
}

function stripRedirections(tokens) {
  const words = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'operator' && REDIRECTION_OPERATORS.has(token.value)) {
      if (token.value.startsWith('<<')) return { safe: false, words: [] };
      const target = tokens[i + 1];
      if (!target || target.type !== 'word' || target.dynamic) return { safe: false, words: [] };
      i += 1;
      continue;
    }
    if (token.type !== 'word') return { safe: false, words: [] };
    words.push(token);
  }
  return { safe: true, words };
}

function assignment(word) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word.value);
  if (!match) return null;
  return { dynamic: word.dynamic, name: match[1], value: match[2] };
}

function withAssignment(context, item) {
  const next = cloneContext(context);
  next.env[item.name] = { dynamic: item.dynamic, value: item.value };
  next.unset = next.unset.filter((name) => name !== item.name);
  return next;
}

function basename(word) {
  return String(word || '').split('/').pop();
}

function unwrapPrefixes(input, inheritedContext) {
  let words = [...input];
  let context = cloneContext(inheritedContext);
  while (words.length) {
    const assigned = assignment(words[0]);
    if (assigned) {
      context = withAssignment(context, assigned);
      words.shift();
      continue;
    }
    const head = words[0];
    if (head.dynamic) return { context, safe: false, words: [] };
    const name = basename(head.value);
    if (name === 'command') {
      words.shift();
      let query = false;
      while (words[0]?.value?.startsWith('-')) {
        const option = words.shift();
        if (option.dynamic) return { context, safe: false, words: [] };
        if (option.value === '--') break;
        if (option.value === '-v' || option.value === '-V') query = true;
        else if (option.value !== '-p') return { context, safe: false, words: [] };
      }
      if (query) return { benign: true, context, safe: true, words: [] };
      continue;
    }
    if (name === 'exec') {
      words.shift();
      while (words[0]?.value?.startsWith('-')) {
        const option = words.shift();
        if (option.dynamic) return { context, safe: false, words: [] };
        if (option.value === '--') break;
        if (option.value === '-c') context.clearEnv = true;
        else if (option.value === '-l') continue;
        else if (option.value === '-a') {
          if (!words.length || words[0].dynamic) return { context, safe: false, words: [] };
          words.shift();
        } else return { context, safe: false, words: [] };
      }
      continue;
    }
    if (name !== 'env') break;

    words.shift();
    while (words.length) {
      const item = words[0];
      const assigned = assignment(item);
      if (assigned) {
        context = withAssignment(context, assigned);
        words.shift();
        continue;
      }
      if (item.dynamic) return { context, safe: false, words: [] };
      const option = item.value;
      if (option === '--') {
        words.shift();
        break;
      }
      if (option === '-' || option === '-i' || option === '--ignore-environment') {
        context.clearEnv = true;
        words.shift();
        continue;
      }
      if (option === '-0' || option === '--null') {
        words.shift();
        continue;
      }
      if (option === '-u' || option === '--unset') {
        words.shift();
        const key = words.shift();
        if (!key || key.dynamic || !key.value) return { context, safe: false, words: [] };
        context.unset.push(key.value);
        delete context.env[key.value];
        continue;
      }
      if (option.startsWith('--unset=')) {
        const key = option.slice('--unset='.length);
        if (!key) return { context, safe: false, words: [] };
        context.unset.push(key);
        delete context.env[key];
        words.shift();
        continue;
      }
      if (option === '-C' || option === '--chdir') {
        words.shift();
        const directory = words.shift();
        if (!directory || directory.dynamic || !directory.value) return { context, safe: false, words: [] };
        context.cwd = directory.value;
        continue;
      }
      if (option.startsWith('-C') && option.length > 2) {
        context.cwd = option.slice(2);
        words.shift();
        continue;
      }
      if (option.startsWith('--chdir=')) {
        const directory = option.slice('--chdir='.length);
        if (!directory) return { context, safe: false, words: [] };
        context.cwd = directory;
        words.shift();
        continue;
      }
      if (option === '-S' || option === '--split-string' || option.startsWith('--split-string=')) {
        return { context, safe: false, words: [] };
      }
      if (option === '-a' || option === '--argv0') {
        words.shift();
        const argv0 = words.shift();
        if (!argv0 || argv0.dynamic) return { context, safe: false, words: [] };
        continue;
      }
      if (option.startsWith('--argv0=')) {
        words.shift();
        continue;
      }
      if (option.startsWith('-')) return { context, safe: false, words: [] };
      break;
    }
  }
  return { context, safe: true, words };
}

function parseGit(words, context) {
  let i = 1;
  const globalArgs = [];
  const takesValue = new Set(['-C', '-c', '--config-env', '--git-dir', '--namespace', '--work-tree']);
  while (i < words.length) {
    const option = words[i];
    if (option.dynamic) return unsafeScan();
    if (!option.value.startsWith('-')) break;
    if (option.value === '--') {
      i += 1;
      break;
    }
    if (takesValue.has(option.value)) {
      const argument = words[i + 1];
      if (!argument || argument.dynamic) return unsafeScan();
      globalArgs.push(option.value, argument.value);
      i += 2;
      continue;
    }
    if (
      option.value.startsWith('-c')
      || option.value.startsWith('-C')
      || option.value.startsWith('--config-env=')
      || option.value.startsWith('--git-dir=')
      || option.value.startsWith('--namespace=')
      || option.value.startsWith('--work-tree=')
    ) {
      globalArgs.push(option.value);
      i += 1;
      continue;
    }
    if (['--bare', '--literal-pathspecs', '--no-lazy-fetch', '--no-optional-locks', '--no-pager', '--no-replace-objects', '--paginate'].includes(option.value)) {
      globalArgs.push(option.value);
      i += 1;
      continue;
    }
    return unsafeScan();
  }
  const subcommand = words[i];
  if (!subcommand || subcommand.dynamic) return unsafeScan();
  const value = subcommand.value;
  if (value === 'push') {
    return { operations: [{ context, globalArgs, kind: 'git-push', subcommand: value, words }], safe: true };
  }
  if (GIT_COMMIT_SUBCOMMANDS.has(value)) {
    return { operations: [{ context, globalArgs, kind: 'git-commit', subcommand: value, subcommandIndex: i, words }], safe: true };
  }
  if (GIT_NON_PUBLISH_SUBCOMMANDS.has(value)) return { operations: [], safe: true };
  return unsafeScan();
}

function ghApiWrites(words, start) {
  let method = '';
  let hasParams = false;
  let endpoint = '';
  const takesValue = new Set(['-H', '--cache', '--header', '--hostname', '--jq', '-p', '--preview', '-q', '-t', '--template']);
  const flags = new Set(['--include', '--paginate', '--silent', '--slurp', '--verbose']);
  for (let i = start; i < words.length; i += 1) {
    const item = words[i];
    if (item.dynamic) return { safe: false, writes: true };
    const arg = item.value;
    if (arg === '-X' || arg === '--method') {
      const value = words[i + 1];
      if (!value || value.dynamic) return { safe: false, writes: true };
      method = value.value.toUpperCase();
      i += 1;
      continue;
    }
    if (arg.startsWith('-X') && arg.length > 2) {
      method = arg.slice(2).toUpperCase();
      continue;
    }
    if (arg.startsWith('--method=')) {
      method = arg.slice('--method='.length).toUpperCase();
      if (!method) return { safe: false, writes: true };
      continue;
    }
    if (arg === '-f' || arg === '--raw-field' || arg === '-F' || arg === '--field' || arg === '--input') {
      if (!words[i + 1]) return { safe: false, writes: true };
      hasParams = true;
      const value = words[i + 1];
      if (!value || value.dynamic) return { safe: false, writes: true };
      i += 1;
      continue;
    }
    if (arg.startsWith('-f') || arg.startsWith('-F') || arg.startsWith('--raw-field=') || arg.startsWith('--field=') || arg.startsWith('--input=')) {
      hasParams = true;
      continue;
    }
    if (takesValue.has(arg)) {
      const value = words[i + 1];
      if (!value || value.dynamic) return { safe: false, writes: true };
      i += 1;
      continue;
    }
    if (flags.has(arg) || arg.startsWith('--cache=') || arg.startsWith('--header=') || arg.startsWith('--hostname=') || arg.startsWith('--jq=') || arg.startsWith('--preview=') || arg.startsWith('--template=')) continue;
    if (arg.startsWith('-')) return { safe: false, writes: true };
    if (endpoint) return { safe: false, writes: true };
    endpoint = arg;
  }
  if (!endpoint) return { safe: false, writes: true };
  if (endpoint === 'graphql') return { safe: true, writes: true };
  if (method === 'GET' || method === 'HEAD') return { safe: true, writes: false };
  if (method) return { safe: true, writes: true };
  return { safe: true, writes: hasParams };
}

function parseGh(words, context) {
  let i = 1;
  const takesValue = new Set(['-R', '--hostname', '--repo']);
  while (i < words.length && words[i].value.startsWith('-')) {
    const option = words[i];
    if (option.dynamic) return unsafeScan();
    if (option.value === '--') {
      i += 1;
      break;
    }
    if (takesValue.has(option.value)) {
      if (!words[i + 1] || words[i + 1].dynamic) return unsafeScan();
      i += 2;
    } else if (option.value.startsWith('--repo=') || option.value.startsWith('--hostname=')) {
      i += 1;
    } else return unsafeScan();
  }
  const command = words[i];
  if (!command || command.dynamic) return unsafeScan();
  const subcommand = words[i + 1];
  if (subcommand?.dynamic) return unsafeScan();
  if (command.value === 'api') {
    const api = ghApiWrites(words, i + 1);
    if (!api.safe) return unsafeScan();
    return api.writes
      ? { operations: [{ context, kind: 'gh-write', words }], safe: true }
      : { operations: [], safe: true };
  }
  const allowed = GH_READ_SUBCOMMANDS[command.value];
  if (allowed?.includes(subcommand?.value || '')) return { operations: [], safe: true };
  return { operations: [{ context, kind: 'gh-write', words }], safe: true };
}

function parseShell(words, context, depth) {
  let i = 1;
  while (i < words.length) {
    const option = words[i];
    if (option.dynamic) return unsafeScan();
    if (option.value === '--') {
      i += 1;
      break;
    }
    if (option.value === '-c' || (/^-[^-]*c/u.test(option.value))) {
      const payload = words[i + 1];
      if (!payload || payload.dynamic) return unsafeScan();
      return inspectCommand(payload.value, depth + 1, context);
    }
    if (option.value.startsWith('-')) {
      i += 1;
      continue;
    }
    return unsafeScan();
  }
  return i < words.length ? unsafeScan() : { operations: [], safe: true };
}

function inspectSimpleCommand(tokens, depth, inheritedContext) {
  const stripped = stripRedirections(tokens);
  if (!stripped.safe) return unsafeScan();
  let words = stripped.words;
  if (!words.length) return { operations: [], safe: true };

  const structural = words[0].dynamic ? '' : words[0].value;
  if (['case', 'for', 'function', 'select'].includes(structural)) return { operations: [], safe: true };
  if (['done', 'esac', 'fi', 'in'].includes(structural)) return { operations: [], safe: true };
  if (['!', 'coproc', 'do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while'].includes(structural)) {
    words = words.slice(1);
  }

  const unwrapped = unwrapPrefixes(words, inheritedContext);
  if (!unwrapped.safe) return unsafeScan();
  if (unwrapped.benign || !unwrapped.words.length) return { operations: [], safe: true };
  words = unwrapped.words;
  const head = words[0];
  if (head.dynamic) return unsafeScan();
  const executable = basename(head.value);
  if (executable === 'git') return parseGit(words, unwrapped.context);
  if (executable === 'gh') return parseGh(words, unwrapped.context);
  if (SHELLS.has(executable)) return parseShell(words, unwrapped.context, depth);
  if (INDIRECT_EXECUTORS.has(executable)) return unsafeScan();
  return { operations: [], safe: true };
}

function inspectCommand(command, depth = 0, context = {}) {
  if (depth > 8) return unsafeScan();
  const lexed = shellLex(command);
  if (!lexed.safe) return unsafeScan();
  const scan = { operations: [], safe: true };
  for (const nested of lexed.substitutions) {
    mergeScan(scan, inspectCommand(nested, depth + 1, context));
  }
  for (const group of commandGroups(lexed.tokens)) {
    mergeScan(scan, inspectSimpleCommand(group, depth, context));
  }
  return scan;
}

function parseUnmanagedAuthors(env = {}) {
  const raw = env.AGENT_BOT_UNMANAGED_AUTHORS;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function identMatches(value, authors) {
  if (!value || !authors.length) return false;
  const lower = String(value).trim().toLowerCase();
  if (authors.includes(lower)) return true;
  const at = lower.indexOf('@');
  if (at <= 0) return false;
  const local = lower.slice(0, at);
  if (authors.includes(local)) return true;
  const plus = local.lastIndexOf('+');
  return plus >= 0 && authors.includes(local.slice(plus + 1));
}

function operationEnvironment(env, context) {
  const merged = context.clearEnv ? {} : { ...env };
  for (const name of context.unset) delete merged[name];
  for (const [name, setting] of Object.entries(context.env)) {
    if (setting.dynamic) return null;
    merged[name] = setting.value;
  }
  return merged;
}

function gitAuthorOverride(operation) {
  if (operation.subcommand !== 'commit') return '';
  let override = '';
  for (let i = operation.subcommandIndex + 1; i < operation.words.length; i += 1) {
    const item = operation.words[i];
    if (item.dynamic) return null;
    if (item.value === '--author') {
      const author = operation.words[i + 1];
      if (!author || author.dynamic || !author.value) return null;
      override = author.value;
      i += 1;
      continue;
    }
    if (item.value.startsWith('--author=')) {
      override = item.value.slice('--author='.length);
      if (!override) return null;
    }
  }
  return override;
}

function parseExplicitAuthor(raw) {
  const match = /^(.*?)\s*<([^<>]+)>$/u.exec(String(raw || '').trim());
  if (!match || !match[1].trim() || !match[2].trim()) return null;
  return { email: match[2].trim(), name: match[1].trim() };
}

function parseGitVarIdent(raw) {
  const match = /^(.*?) <([^<>]+)> [0-9]+ [+-][0-9]{4}$/u.exec(String(raw || '').trim());
  if (!match || !match[1].trim() || !match[2].trim()) return null;
  return { email: match[2].trim(), name: match[1].trim() };
}

function commitUsesCurrentAuthor(operation) {
  if (operation.subcommand !== 'commit') return true;
  let reusesAuthor = false;
  let resetsAuthor = false;
  for (let i = operation.subcommandIndex + 1; i < operation.words.length; i += 1) {
    const item = operation.words[i];
    if (item.dynamic) return false;
    const value = item.value;
    if (value === '--reset-author') resetsAuthor = true;
    if (
      value === '--amend'
      || value === '-C'
      || value === '-c'
      || value === '--reuse-message'
      || value === '--reedit-message'
      || value.startsWith('-C')
      || value.startsWith('-c')
      || value.startsWith('--reuse-message=')
      || value.startsWith('--reedit-message=')
    ) reusesAuthor = true;
  }
  return !reusesAuthor || resetsAuthor;
}

function runGitIdent(operation, env, variable) {
  try {
    const run = spawnSync('git', [...operation.globalArgs, 'var', variable], {
      cwd: operation.context.cwd || undefined,
      encoding: 'utf8',
      env,
      timeout: 2000,
    });
    if (run.status !== 0 || run.error) return null;
    return parseGitVarIdent(run.stdout);
  } catch {
    return null;
  }
}

function resolveGitIdentities(env, operation) {
  if (INPUT_DERIVED_GIT_AUTHORS.has(operation.subcommand)) return null;
  const effectiveEnv = operationEnvironment(env, operation.context);
  if (!effectiveEnv) return null;
  const override = gitAuthorOverride(operation);
  if (override === null) return null;
  if (!override && !commitUsesCurrentAuthor(operation)) return null;
  if (override) {
    const explicit = parseExplicitAuthor(override);
    if (!explicit) return null;
    effectiveEnv.GIT_AUTHOR_NAME = explicit.name;
    effectiveEnv.GIT_AUTHOR_EMAIL = explicit.email;
  }
  const author = runGitIdent(operation, effectiveEnv, 'GIT_AUTHOR_IDENT');
  const committer = runGitIdent(operation, effectiveEnv, 'GIT_COMMITTER_IDENT');
  return author && committer ? { author, committer } : null;
}

function identityAllowed(identity, authors) {
  return identMatches(identity.name, authors) && identMatches(identity.email, authors);
}

function resolveGhLogin(env = {}) {
  const fromEnv = env.GH_USER || env.GITHUB_USER || env.GITHUB_ACTOR || '';
  if (fromEnv) return String(fromEnv).trim().toLowerCase();
  try {
    const run = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (run.status === 0) return (run.stdout || '').trim().toLowerCase();
  } catch {}
  return '';
}

function isUnmanagedGitAuthor(env, authors, operation) {
  const identities = resolveGitIdentities(env, operation);
  return Boolean(
    identities
    && identityAllowed(identities.author, authors)
    && identityAllowed(identities.committer, authors)
  );
}

function isUnmanagedGhActor(env, authors) {
  return authors.includes(resolveGhLogin(env));
}

function isHumanAttributedPublish(command) {
  const scan = inspectCommand(command);
  return !scan.safe || scan.operations.length > 0;
}

function unmanagedPublishAllowed(command, env, authors) {
  if (!authors.length) return false;
  const scan = inspectCommand(command);
  if (!scan.safe || !scan.operations.length) return false;
  for (const operation of scan.operations) {
    if (operation.kind === 'git-commit' && !isUnmanagedGitAuthor(env, authors, operation)) return false;
    if (operation.kind === 'git-push' && !isUnmanagedGhActor(env, authors)) return false;
    if (operation.kind === 'gh-write' && !isUnmanagedGhActor(env, authors)) return false;
  }
  return true;
}

function uninstalledDecision({ event, command = '', env = {} }) {
  const authors = parseUnmanagedAuthors(env);
  if (event === 'pre-commit') {
    const operation = {
      context: cloneContext(),
      globalArgs: [],
      subcommand: 'commit',
      subcommandIndex: 1,
      words: [{ dynamic: false, value: 'git' }, { dynamic: false, value: 'commit' }],
    };
    if (authors.length && isUnmanagedGitAuthor(env, authors, operation)) {
      return { decision: 'allow', reason: '' };
    }
    return { decision: 'deny', reason: UNINSTALLED_REASON };
  }
  if (event === 'pre-push') {
    if (authors.length && isUnmanagedGhActor(env, authors)) {
      return { decision: 'allow', reason: '' };
    }
    return { decision: 'deny', reason: UNINSTALLED_REASON };
  }
  if (event === 'pre-command' && isHumanAttributedPublish(command)) {
    if (unmanagedPublishAllowed(command, env, authors)) {
      return { decision: 'allow', reason: '' };
    }
    return { decision: 'deny', reason: UNINSTALLED_REASON };
  }
  return { decision: 'allow', reason: '' };
}

const RUNTIME_FUNCTIONS = [
  cloneContext,
  unsafeScan,
  mergeScan,
  extractCommand,
  readDollarParen,
  readBackticks,
  shellLex,
  commandGroups,
  stripRedirections,
  assignment,
  withAssignment,
  basename,
  unwrapPrefixes,
  parseGit,
  ghApiWrites,
  parseGh,
  parseShell,
  inspectSimpleCommand,
  inspectCommand,
  parseUnmanagedAuthors,
  identMatches,
  operationEnvironment,
  gitAuthorOverride,
  parseExplicitAuthor,
  parseGitVarIdent,
  commitUsesCurrentAuthor,
  runGitIdent,
  resolveGitIdentities,
  identityAllowed,
  resolveGhLogin,
  isUnmanagedGitAuthor,
  isUnmanagedGhActor,
  isHumanAttributedPublish,
  unmanagedPublishAllowed,
  uninstalledDecision,
];

function responseFor(dialect) {
  if (dialect === 'cursor') {
    return {
      allow: { stdout: '{}', stderr: '', exitCode: 0 },
      deny: {
        stdout: JSON.stringify({
          permission: 'deny',
          agent_message: UNINSTALLED_REASON,
          user_message: UNINSTALLED_REASON,
        }),
        stderr: '',
        exitCode: 0,
      },
    };
  }
  if (dialect !== 'claude' && dialect !== 'codex') throw new Error(`unsupported dialect ${dialect}`);
  return {
    allow: { stdout: '', stderr: '', exitCode: 0 },
    deny: {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: UNINSTALLED_REASON,
        },
      }),
      stderr: UNINSTALLED_REASON,
      exitCode: 0,
    },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderUninstalledIdentitySource(dialect) {
  const response = responseFor(dialect);
  return [
    'import { readFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    `const UNINSTALLED_REASON = ${JSON.stringify(UNINSTALLED_REASON)};`,
    `const CONTROL_OPERATORS = new Set(${JSON.stringify([...CONTROL_OPERATORS])});`,
    `const REDIRECTION_OPERATORS = new Set(${JSON.stringify([...REDIRECTION_OPERATORS])});`,
    `const GIT_COMMIT_SUBCOMMANDS = new Set(${JSON.stringify([...GIT_COMMIT_SUBCOMMANDS])});`,
    `const INPUT_DERIVED_GIT_AUTHORS = new Set(${JSON.stringify([...INPUT_DERIVED_GIT_AUTHORS])});`,
    `const GIT_NON_PUBLISH_SUBCOMMANDS = new Set(${JSON.stringify([...GIT_NON_PUBLISH_SUBCOMMANDS])});`,
    `const SHELLS = new Set(${JSON.stringify([...SHELLS])});`,
    `const INDIRECT_EXECUTORS = new Set(${JSON.stringify([...INDIRECT_EXECUTORS])});`,
    `const GH_READ_SUBCOMMANDS = ${JSON.stringify(GH_READ_SUBCOMMANDS)};`,
    ...RUNTIME_FUNCTIONS.map((fn) => fn.toString()),
    `const allow = ${JSON.stringify(response.allow)};`,
    `const deny = ${JSON.stringify(response.deny)};`,
    'let raw = "";',
    'try { if (!process.stdin.isTTY) raw = readFileSync(0, "utf8"); } catch {}',
    'let payload = {};',
    'try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch {}',
    'if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};',
    'const verdict = uninstalledDecision({',
    '  event: "pre-command",',
    '  command: extractCommand(payload, process.env),',
    '  env: process.env,',
    '});',
    'const encoded = verdict.decision === "deny" ? deny : allow;',
    'if (encoded.stdout) process.stdout.write(encoded.stdout);',
    'if (encoded.stderr) process.stderr.write(encoded.stderr + "\\n");',
    'process.exit(encoded.exitCode);',
    '',
  ].join('\n');
}

export function renderUninstalledIdentityCommand(dialect) {
  const source = renderUninstalledIdentitySource(dialect);
  return `export AGENT_BOT_UNMANAGED_AUTHORS="\${AGENT_BOT_UNMANAGED_AUTHORS-ai9d}"; H="\${AGENT_BOT_HOOK_BIN:-$HOME/.local/share/agent-bot/agent-hook}"; [ -x "$H" ] && exec "$H" --dialect ${dialect} --event pre-command; node --input-type=module -e ${shellQuote(source)} # agent-bot agent-hook`;
}

export {
  inspectCommand,
  uninstalledDecision,
};
