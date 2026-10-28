'use strict';

// npm run protocol:export: src/protocol.js as JSON in docs/protocol.json (what the Rust side of Tauri
// reads to check its list of commands), and the table of docs/PROTOCOL.md. Commit both.
// `--check` writes nothing and fails when they are old (the tests do the same).

const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS, EVENTS, SCOPES } = require('../src/protocol');

const docs = path.join(__dirname, '..', 'docs');

const json = `${JSON.stringify({ version: 1, scopes: SCOPES, commands: COMMANDS, events: EVENTS }, null, 2)}\n`;

function type(schema) {
  if (!schema) return 'any';
  let t = schema.type;
  if (schema.enum) t = schema.enum.map((v) => `\`${v}\``).join(' \\| ');
  else if (schema.type === 'array') t = `array${schema.items ? `<${type(schema.items)}>` : ''}`;
  else if (schema.type === 'object' && schema.props && Object.keys(schema.props).length) {
    t = `{ ${Object.entries(schema.props).map(([k, p]) => `${k}${p.required ? '' : '?'}: ${type(p)}`).join(', ')} }`;
  }
  if (schema.type === 'string' && schema.max != null && !schema.enum) t += ` (max ${schema.max})`;
  if (schema.int) t = `integer`;
  return schema.nullable ? `${t} \\| null` : t;
}

const args = (c) => (c.params.length ? c.params.map((p) => `\`${p.name}${p.optional ? '?' : ''}\`: ${type(p)}`).join('<br>') : '-');
const reply = (c) => (c.kind === 'send' ? '-' : type(c.reply));

function table(scope) {
  const rows = COMMANDS.filter((c) => c.scope === scope).map((c) => `| \`${c.name}\` | \`${c.channel}\` | ${c.kind} | ${args(c)} | ${reply(c)} | ${c.doc.replace(/\|/g, '\\|')} |`);
  return ['| Command | Channel | Kind | Arguments | Reply | What |', '|---|---|---|---|---|---|', ...rows].join('\n');
}
function events(scope) {
  const rows = EVENTS.filter((e) => e.scope === scope).map((e) => `| \`${e.name}\` | \`${e.event}\` | ${type(e.payload)} | ${e.doc.replace(/\|/g, '\\|')} |`);
  return ['| Event | Channel | Payload | What |', '|---|---|---|---|', ...rows].join('\n');
}

// docs/PROTOCOL.md: the text around the tables is in docs/PROTOCOL.head.md; the tables are made here
const head = fs.readFileSync(path.join(docs, 'PROTOCOL.head.md'), 'utf8').trimEnd();
const markdown = `${head}

<!-- The tables below are generated: npm run protocol:export. Do not edit them by hand. -->

## Overlay commands (${COMMANDS.filter((c) => c.scope === 'overlay').length})

${table('overlay')}

## Overlay events (${EVENTS.filter((e) => e.scope === 'overlay').length})

${events('overlay')}

## Settings window commands (${COMMANDS.filter((c) => c.scope === 'settings').length})

${table('settings')}

## Settings window events (${EVENTS.filter((e) => e.scope === 'settings').length})

${events('settings')}
`;

const targets = [[path.join(docs, 'protocol.json'), json], [path.join(docs, 'PROTOCOL.md'), markdown]];
if (process.argv.includes('--check')) {
  const old = targets.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text);
  if (old.length) {
    console.error(`old: ${old.map(([f]) => path.relative(process.cwd(), f)).join(', ')} (npm run protocol:export)`);
    process.exit(1);
  }
} else {
  for (const [file, text] of targets) fs.writeFileSync(file, text);
  console.log(`protocol: ${COMMANDS.length} commands, ${EVENTS.length} events -> docs/protocol.json, docs/PROTOCOL.md`);
}
