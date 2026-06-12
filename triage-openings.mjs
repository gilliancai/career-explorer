#!/usr/bin/env node
// triage-openings.mjs — heuristic scoring of openings.json against the user's profile.
// Fast (no LLM calls). Outputs a sorted ranking — use it to pick the top 5–10 for deep-dive.
//
// Usage:  node triage-openings.mjs
// Input:  output/openings.json (run fetch-openings.mjs first)
// Output: output/triage-rankings.md, output/triage-rankings.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPENINGS = path.join(ROOT, 'output/openings.json');
const OUT_MD = path.join(ROOT, 'output/triage-rankings.md');
const OUT_JSON = path.join(ROOT, 'output/triage-rankings.json');

const TIER1 = new Set(['Google Cloud', 'Microsoft', 'OpenAI', 'Anthropic', 'NVIDIA']);
const TIER2 = new Set(['Databricks', 'Snowflake', 'Confluent', 'Palantir', 'Elastic', 'dbt Labs', 'Cohere']);
const APPLIED_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']);

// ─── Build set of URLs already applied to (so we skip them in triage) ───
function loadAppliedUrls() {
  const md = fs.readFileSync(path.join(ROOT, 'data/applications.md'), 'utf8');
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  const urls = new Set();
  for (const line of lines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 9) continue;
    if (!APPLIED_STATUSES.has(cells[5])) continue;
    const reportPath = (cells[7].match(/\(([^)]+)\)/) || [])[1] || '';
    if (!reportPath) continue;
    const reportFull = path.join(ROOT, reportPath);
    if (!fs.existsSync(reportFull)) continue;
    const m = fs.readFileSync(reportFull, 'utf8').match(/\*\*URL:\*\*\s*([^\n]+)/);
    if (m) urls.add(canonicalJobKey(m[1]));
  }
  return urls;
}

// Canonical job identity (matches serve-dashboard.mjs).
function canonicalJobKey(url) {
  if (!url) return '';
  const u = url.trim();
  const ghJid = u.match(/[?&]gh_jid=(\d+)/);
  if (ghJid) return `gh:${ghJid[1]}`;
  const ghDirect = u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/i);
  if (ghDirect) return `gh:${ghDirect[1]}`;
  const ashby = u.match(/jobs\.ashbyhq\.com\/[^/?#]+\/([a-f0-9-]{36})/i);
  if (ashby) return `ashby:${ashby[1].toLowerCase()}`;
  const lever = u.match(/jobs\.lever\.co\/[^/?#]+\/([a-f0-9-]{36})/i);
  if (lever) return `lever:${lever[1].toLowerCase()}`;
  const workday = u.match(/_(JR\d+)/i);
  if (workday) return `workday:${workday[1].toUpperCase()}`;
  return u.toLowerCase().replace(/\/+$/, '').replace(/[?#].*$/, '');
}

// ─── Heuristic scorer ────────────────────────────────────────────────
function scoreOpening(o) {
  let s = 2.5; // baseline (anything that passed qualification filter is at least 2.5)
  const reasons = [];
  const t = (o.title || '').toLowerCase();
  const l = (o.location || '').toLowerCase();

  // ── Title × archetype ──
  if (/strategic\s+(enterprise\s+)?account|strategic\s+account\s+executive/.test(t)) {
    s += 1.5; reasons.push('Strategic AE — primary archetype');
  } else if (/enterprise\s+account\s+executive|enterprise\s+sales/.test(t)) {
    s += 1.3; reasons.push('Enterprise AE — primary archetype');
  } else if (/account\s+executive|account\s+manager|sales\s+executive/.test(t)) {
    s += 0.9; reasons.push('AE / AM title');
  } else if (/community\s+(builder|manager)|developer\s+relations|devrel/.test(t)) {
    s += 0.9; reasons.push('Community / DevRel — secondary archetype');
  } else if (/(product|partner|customer|solutions)\s+marketing/.test(t)) {
    s += 0.6; reasons.push('Marketing — secondary archetype');
  } else if (/\bgtm\b/.test(t)) {
    s += 0.5; reasons.push('GTM — secondary archetype');
  } else {
    s -= 0.3; reasons.push('Title not in core archetype');
  }

  // ── Segment ──
  if (/mid[- ]market|\bsmb\b|emerging|startup\s+account/.test(t)) {
    s -= 0.4; reasons.push('Mid-Market / SMB segment (below her target)');
  } else if (/strategic|major(s)?|named\s+account|principal|lead\s+account/.test(t)) {
    s += 0.3; reasons.push('Senior segment (matches her level)');
  }

  // ── Vertical ──
  if (/financial\s+services|fsi|banking|insurance|fintech/.test(t)) {
    s += 0.4; reasons.push('FSI vertical — her strongest');
  } else if (/industries|commercial|generalist/.test(t)) {
    s += 0.2; reasons.push('Cross-industry / Commercial');
  } else if (/healthcare|pharma|life\s+sciences|retail|manufacturing|energy|utilities|telco|automotive/.test(t)) {
    s -= 0.4; reasons.push('Niche vertical — no prior exposure');
  } else if (/\btech\b|\btechnology\b|digital\s+native/.test(t)) {
    s += 0.1; reasons.push('Tech vertical');
  }

  // ── Company tier ──
  if (TIER1.has(o.company)) {
    s += 0.6; reasons.push('Tier 1 target company');
  } else if (TIER2.has(o.company)) {
    s += 0.3; reasons.push('Tier 2 target company');
  }

  // ── Location × visa ──
  if (/(toronto|vancouver|ontario|montreal|calgary|ottawa|canada)/.test(l)) {
    s += 0.6; reasons.push('Canada — no visa needed');
  } else if (/^remote\b|^anywhere\b|^distributed\b|us\s*-\s*remote|remote\s*-\s*us|us\s+remote/.test(l)) {
    s += 0.3; reasons.push('Remote (US-based)');
  } else if (/london|united\s+kingdom/.test(l)) {
    s += 0.2; reasons.push('London — UK visa sponsorship needed');
  } else if (/new\s+york|san\s+francisco|seattle|bay\s+area/.test(l)) {
    s += 0.2; reasons.push('US target city — US visa sponsorship needed');
  }

  s = Math.max(0, Math.min(5, s));
  return { score: Math.round(s * 10) / 10, reasons };
}

function bucket(score) {
  if (score >= 4.5) return 'priority';
  if (score >= 4.0) return 'consider';
  if (score >= 3.5) return 'review';
  return 'skip';
}

// ─── Main ────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(OPENINGS)) {
    console.error('✗ output/openings.json not found. Run: node fetch-openings.mjs');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(OPENINGS, 'utf8'));
  const applied = loadAppliedUrls();

  const all = Object.values(data.grouped)
    .flat()
    .filter((o) => !applied.has(canonicalJobKey(o.url)));

  const scored = all
    .map((o) => ({ ...o, ...scoreOpening(o), bucket: '' }))
    .map((o) => ({ ...o, bucket: bucket(o.score) }))
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));

  // ── Markdown ──
  const today = new Date().toISOString().slice(0, 10);
  let md = `# Triage Rankings — ${all.length} Openings\n\n`;
  md += `**Generated:** ${today}\n`;
  md += `**Source:** \`output/openings.json\` filtered by qualification rules + already-applied\n\n`;
  md += `**Score legend:** \`≥4.5\` priority · \`4.0–4.4\` consider · \`3.5–3.9\` review · \`<3.5\` skip\n\n---\n\n`;

  const groups = { priority: [], consider: [], review: [], skip: [] };
  scored.forEach((o) => groups[o.bucket].push(o));

  const labels = {
    priority: '🟢 Priority — apply this week (≥4.5)',
    consider: '🟡 Consider — apply if priority list is small (4.0–4.4)',
    review: '🟠 Review — read JD carefully before deciding (3.5–3.9)',
    skip: '🔴 Skip — below threshold (<3.5)',
  };

  for (const k of ['priority', 'consider', 'review', 'skip']) {
    const list = groups[k];
    if (!list.length) continue;
    md += `## ${labels[k]} — ${list.length} roles\n\n`;
    md += `| Score | Company | Title | Location | Why |\n|---|---|---|---|---|\n`;
    for (const o of list) {
      const why = o.reasons.slice(0, 2).join(' · ').replace(/\|/g, '/');
      md += `| **${o.score}** | ${o.company} | [${o.title}](${o.url}) | ${o.location.slice(0, 50)} | ${why} |\n`;
    }
    md += '\n';
  }

  fs.writeFileSync(OUT_MD, md);
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify({ generatedAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), scored }, null, 2),
  );

  console.log(`✓ Triage: ${path.relative(ROOT, OUT_MD)}`);
  console.log(`  ${all.length} openings scored (after applied-filter)`);
  for (const k of ['priority', 'consider', 'review', 'skip']) {
    console.log(`  ${k.padEnd(9)} ${groups[k].length}`);
  }
}

main();
