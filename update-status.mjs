#!/usr/bin/env node
// update-status.mjs — change the status of an existing application.
// Usage:
//   node update-status.mjs <num> <Status> [note]
//   node update-status.mjs            # interactive mode (lists apps, prompts)
// Status must be one of templates/states.yml. The note (optional) is
// appended to the Notes column with today's date prefixed by the action verb
// (e.g. "Rejected 2026-05-03 — moving on with other candidates").

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APPS_FILE = path.join(ROOT, 'data/applications.md');
const STATES_FILE = path.join(ROOT, 'templates/states.yml');

const today = () => new Date().toISOString().slice(0, 10);

export function loadStates() {
  const cfg = yaml.load(fs.readFileSync(STATES_FILE, 'utf8'));
  const map = new Map();
  for (const s of cfg.states) {
    map.set(s.label.toLowerCase(), s.label);
    for (const a of s.aliases || []) map.set(a.toLowerCase(), s.label);
  }
  return map;
}

export function resolveStatus(input, states) {
  const hit = states.get(input.toLowerCase());
  if (!hit) {
    const labels = [...new Set(states.values())].join(', ');
    throw new Error(`Unknown status "${input}". Valid: ${labels}`);
  }
  return hit;
}

function parseRows(md) {
  const lines = md.split('\n');
  const rows = [];
  lines.forEach((line, i) => {
    if (!line.trim().startsWith('|')) return;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 9) return;
    if (cells[0] === '#' || cells[0].startsWith('---')) return;
    const num = parseInt(cells[0], 10);
    if (Number.isNaN(num)) return;
    rows.push({
      lineIndex: i,
      raw: line,
      num,
      date: cells[1],
      company: cells[2],
      role: cells[3],
      score: cells[4],
      status: cells[5],
      pdf: cells[6],
      report: cells[7],
      notes: cells[8],
    });
  });
  return { lines, rows };
}

function rebuildLine(row) {
  return `| ${row.num} | ${row.date} | ${row.company} | ${row.role} | ${row.score} | ${row.status} | ${row.pdf} | ${row.report} | ${row.notes} |`;
}

export function applyUpdate(num, newStatus, note) {
  const md = fs.readFileSync(APPS_FILE, 'utf8');
  const { lines, rows } = parseRows(md);
  const target = rows.find((r) => r.num === num);
  if (!target) {
    const ids = rows.map((r) => r.num).sort((a, b) => a - b).join(', ');
    throw new Error(`No application #${num}. Existing: ${ids}`);
  }
  const before = target.status;
  target.status = newStatus;
  if (note && note.trim()) {
    const stamp = `${newStatus} ${today()} — ${note.trim()}`;
    target.notes = target.notes ? `${target.notes} ${stamp}` : stamp;
  }
  lines[target.lineIndex] = rebuildLine(target);
  fs.writeFileSync(APPS_FILE, lines.join('\n'));
  return { num, company: target.company, role: target.role, before, after: newStatus };
}

function listRows() {
  const md = fs.readFileSync(APPS_FILE, 'utf8');
  const { rows } = parseRows(md);
  rows.sort((a, b) => b.num - a.num);
  console.log('\nCurrent applications:');
  for (const r of rows) {
    console.log(`  #${String(r.num).padStart(3, '0')}  ${r.status.padEnd(10)}  ${r.company} — ${r.role}`);
  }
  console.log('');
  return rows;
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function interactive(states) {
  listRows();
  const numStr = await prompt('Enter # to update: ');
  const num = parseInt(numStr, 10);
  if (Number.isNaN(num)) throw new Error('Invalid number');
  const labels = [...new Set(states.values())].join(' / ');
  const statusStr = await prompt(`New status (${labels}): `);
  const newStatus = resolveStatus(statusStr, states);
  const note = await prompt('Note (optional, e.g. reason): ');
  return { num, newStatus, note };
}

async function main() {
  const states = loadStates();
  const args = process.argv.slice(2);

  let num, newStatus, note = '';
  if (args.length === 0) {
    ({ num, newStatus, note } = await interactive(states));
  } else if (args.length < 2) {
    console.error('Usage: node update-status.mjs <num> <Status> [note]');
    process.exit(1);
  } else {
    num = parseInt(args[0], 10);
    if (Number.isNaN(num)) throw new Error(`Invalid #: ${args[0]}`);
    newStatus = resolveStatus(args[1], states);
    note = args.slice(2).join(' ');
  }

  const result = applyUpdate(num, newStatus, note);
  console.log(`✓ #${String(result.num).padStart(3, '0')} ${result.company} — ${result.role}`);
  console.log(`  ${result.before} → ${result.after}`);
  if (note) console.log(`  + note: "${note}"`);
  console.log('\nRun `node generate-dashboard.mjs` to refresh the dashboard.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
