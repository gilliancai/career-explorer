#!/usr/bin/env node
// apply-digest.mjs — end-of-day reminder of qualified openings worth applying to.
//
// Reads output/triage-rankings.json and sends a macOS desktop notification
// summarizing how many qualified openings are ready to review and apply to.
// Run each evening by the com.example.career-ops.digest LaunchAgent.
//
// Usage: node apply-digest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RANKINGS = path.join(ROOT, 'output/triage-rankings.json');

function notify(title, message) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
  execFile('osascript', ['-e', script], (err) => {
    if (err) console.error('apply-digest: notification failed:', err.message);
  });
}

if (!fs.existsSync(RANKINGS)) {
  console.error('apply-digest: output/triage-rankings.json not found — run triage-openings.mjs first.');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(RANKINGS, 'utf8'));
const counts = data.counts || {};
const priority = counts.priority || 0;
const consider = counts.consider || 0;
const scored = Array.isArray(data.scored) ? data.scored : [];

// Up to 3 distinct top-priority companies, highest score first.
const topCompanies = [];
for (const o of scored.filter((s) => s.bucket === 'priority').sort((a, b) => b.score - a.score)) {
  if (o.company && !topCompanies.includes(o.company)) topCompanies.push(o.company);
  if (topCompanies.length >= 3) break;
}

const title = 'Career-Ops — End-of-Day Apply Digest';
let message;
if (priority + consider === 0) {
  message = 'No qualified openings pending. Your pipeline is up to date.';
} else {
  const head = `${priority} priority + ${consider} to consider.`;
  const tops = topCompanies.length ? ` Top: ${topCompanies.join(', ')}.` : '';
  message = `${head}${tops} Open your Career Dashboard to review and apply.`;
}

console.log(`apply-digest @ ${new Date().toISOString()} — ${message}`);
notify(title, message);
