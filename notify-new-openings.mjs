#!/usr/bin/env node

/**
 * notify-new-openings.mjs
 *
 * Detects newly-posted openings from tracked companies and emits a macOS
 * desktop notification so you can be among the first applicants.
 *
 * Pipeline:
 *   1. Run fetchOpenings() — pulls fresh from public ATS APIs.
 *   2. Diff job URLs against output/openings.snapshot.json (previous run).
 *   3. For each NEW url: append to data/new-openings.log + osascript notify.
 *   4. Save current as new snapshot.
 *
 * Designed to run hourly via launchd. Idempotent — re-running with no new
 * postings emits no notification and leaves snapshot unchanged.
 *
 * Usage:
 *   node notify-new-openings.mjs              # run once, notify on diff
 *   node notify-new-openings.mjs --dry-run    # show what would notify, don't write snapshot
 *   node notify-new-openings.mjs --force      # ignore prev snapshot (treat all as new)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchOpenings } from './fetch-openings.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(ROOT, 'output/openings.snapshot.json');
const LOG_FILE = path.join(ROOT, 'data/new-openings.log');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

function flatten(grouped) {
  return Object.values(grouped || {}).flat();
}

function loadSnapshot() {
  if (FORCE || !fs.existsSync(SNAPSHOT_FILE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return new Set(flatten(data.grouped).map((j) => j.url));
  } catch {
    return new Set();
  }
}

function macNotify(title, message, openUrl) {
  // osascript display notification has no clickable URL, but `open <url>`
  // we wire later via a tiny shell wrapper if you want it.
  const safeTitle = title.replace(/"/g, '\\"');
  const safeMsg = message.replace(/"/g, '\\"');
  try {
    execSync(`osascript -e 'display notification "${safeMsg}" with title "${safeTitle}" sound name "Glass"'`, { stdio: 'pipe' });
  } catch (err) {
    console.error('osascript failed:', err.message);
  }
  if (openUrl) {
    // Don't auto-open — just log it; open the dashboard manually.
  }
}

function appendLog(lines) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const stamp = new Date().toISOString();
  const text = lines.map((l) => `${stamp}\t${l}`).join('\n') + '\n';
  fs.appendFileSync(LOG_FILE, text);
}

async function main() {
  const data = await fetchOpenings();
  const current = flatten(data.grouped);
  const prevUrls = loadSnapshot();

  const newJobs = current.filter((j) => !prevUrls.has(j.url));

  if (newJobs.length === 0) {
    console.log(`✓ No new openings (${current.length} total tracked, ${prevUrls.size} in prev snapshot)`);
    if (!DRY_RUN && !FORCE) {
      // Still update snapshot in case removed jobs changed the set
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
    }
    return;
  }

  const counts = {};
  for (const j of newJobs) counts[j.company] = (counts[j.company] || 0) + 1;

  const headline = newJobs.length === 1
    ? `1 new opening at ${newJobs[0].company}`
    : `${newJobs.length} new openings — ${Object.entries(counts).map(([c, n]) => `${c} (${n})`).join(', ')}`;

  // Take up to 3 titles for the body
  const sample = newJobs.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join(' · ');
  const body = newJobs.length > 3 ? `${sample} … +${newJobs.length - 3} more` : sample;

  console.log(`🔔 ${headline}`);
  for (const j of newJobs) console.log(`   + [${j.company}] ${j.title} — ${j.location}`);
  console.log(`   Total tracked: ${current.length} (was ${prevUrls.size})`);

  if (DRY_RUN) {
    console.log('(dry-run: no notification, snapshot not updated)');
    return;
  }

  appendLog(newJobs.map((j) => `${j.company}\t${j.title}\t${j.location}\t${j.url}`));
  macNotify(headline, body);

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error('notify-new-openings failed:', err.message);
  process.exit(1);
});
