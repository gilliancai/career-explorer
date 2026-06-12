#!/usr/bin/env node
// serve-dashboard.mjs — local HTTP server for the interactive dashboard.
// Renders the dashboard fresh on each GET / and accepts status updates on
// POST /api/status. Stays local (binds to 127.0.0.1).
//
// Usage:
//   node serve-dashboard.mjs           # port 4321
//   PORT=5000 node serve-dashboard.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHtml } from './generate-dashboard.mjs';
import { applyUpdate, loadStates, resolveStatus } from './update-status.mjs';
import { fetchOpenings } from './fetch-openings.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPENINGS_CACHE = path.join(ROOT, 'output/openings.json');
const OPENINGS_TTL_MS = 60 * 60 * 1000; // 1 hour

const APPLIED_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']);

// Canonical job identity. Two URLs that point to the same posting (e.g.
// short scan URL vs. fully-redirected pretty URL) hash to the same key,
// so the applied-filter actually catches them.
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

// Build the set of JD URLs you have applied to, by reading the report
// linked from each applied row in applications.md.
function loadAppliedUrls() {
  const md = fs.readFileSync(path.join(ROOT, 'data/applications.md'), 'utf8');
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  const urls = new Set();
  for (const line of lines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 9) continue;
    const status = cells[5];
    if (!APPLIED_STATUSES.has(status)) continue;
    const reportPath = (cells[7].match(/\(([^)]+)\)/) || [])[1] || '';
    if (!reportPath) continue;
    const reportFull = path.join(ROOT, reportPath);
    if (!fs.existsSync(reportFull)) continue;
    const reportText = fs.readFileSync(reportFull, 'utf8');
    const m = reportText.match(/\*\*URL:\*\*\s*([^\n]+)/);
    if (m) urls.add(canonicalJobKey(m[1]));
  }
  return urls;
}

function filterOutApplied(data) {
  const applied = loadAppliedUrls();
  let removed = 0;
  const grouped = {};
  for (const [loc, jobs] of Object.entries(data.grouped)) {
    grouped[loc] = jobs.filter((j) => {
      const drop = applied.has(canonicalJobKey(j.url));
      if (drop) removed++;
      return !drop;
    });
  }
  return {
    ...data,
    grouped,
    stats: { ...data.stats, totalKept: data.stats.totalKept - removed, hiddenApplied: removed },
  };
}

// Build the set of canonical keys for openings the user has manually
// dismissed via data/openings-dismissed.txt (one job URL per line, # comments).
function loadDismissedKeys() {
  const file = path.join(ROOT, 'data/openings-dismissed.txt');
  if (!fs.existsSync(file)) return new Set();
  const keys = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    keys.add(canonicalJobKey(line));
  }
  return keys;
}

function filterOutDismissed(data) {
  const dismissed = loadDismissedKeys();
  if (!dismissed.size) return data;
  let removed = 0;
  const grouped = {};
  for (const [loc, jobs] of Object.entries(data.grouped)) {
    grouped[loc] = jobs.filter((j) => {
      const drop = dismissed.has(canonicalJobKey(j.url));
      if (drop) removed++;
      return !drop;
    });
  }
  return {
    ...data,
    grouped,
    stats: { ...data.stats, totalKept: data.stats.totalKept - removed, hiddenDismissed: removed },
  };
}

// Tag each job with isNew=true if its URL was not in the previous notification
// snapshot. The snapshot is written hourly by notify-new-openings.mjs (launchd),
// so "new" effectively means "appeared in the API since the last hourly check".
function tagNewSinceSnapshot(data) {
  const SNAPSHOT_FILE = path.join(ROOT, 'output/openings.snapshot.json');
  if (!fs.existsSync(SNAPSHOT_FILE)) return data;
  let prevUrls;
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    prevUrls = new Set(Object.values(snap.grouped || {}).flat().map((j) => j.url));
  } catch {
    return data;
  }
  let newCount = 0;
  const grouped = {};
  for (const [loc, jobs] of Object.entries(data.grouped)) {
    grouped[loc] = jobs.map((j) => {
      const isNew = !prevUrls.has(j.url);
      if (isNew) newCount++;
      return isNew ? { ...j, isNew: true } : j;
    });
  }
  return { ...data, grouped, stats: { ...data.stats, newSinceSnapshot: newCount } };
}

const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';

let openingsRefreshInFlight = null;

async function getOpenings({ forceRefresh = false } = {}) {
  if (!forceRefresh && fs.existsSync(OPENINGS_CACHE)) {
    const stat = fs.statSync(OPENINGS_CACHE);
    if (Date.now() - stat.mtimeMs < OPENINGS_TTL_MS) {
      return JSON.parse(fs.readFileSync(OPENINGS_CACHE, 'utf8'));
    }
  }
  if (openingsRefreshInFlight) return openingsRefreshInFlight;
  openingsRefreshInFlight = (async () => {
    try {
      const data = await fetchOpenings();
      fs.mkdirSync(path.dirname(OPENINGS_CACHE), { recursive: true });
      fs.writeFileSync(OPENINGS_CACHE, JSON.stringify(data, null, 2));
      return data;
    } finally {
      openingsRefreshInFlight = null;
    }
  })();
  return openingsRefreshInFlight;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const { html } = buildHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/status') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid JSON');
        return;
      }
      const num = Number(payload.num);
      if (!Number.isFinite(num)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing num');
        return;
      }
      const states = loadStates();
      let status;
      try {
        status = resolveStatus(String(payload.status || ''), states);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(err.message);
        return;
      }
      const note = String(payload.note || '');
      const result = applyUpdate(num, status, note);
      console.log(`✓ #${String(result.num).padStart(3, '0')} ${result.before} → ${result.after}  (${result.company})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/openings') {
      const data = tagNewSinceSnapshot(filterOutDismissed(filterOutApplied(await getOpenings())));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/openings/refresh') {
      const data = tagNewSinceSnapshot(filterOutDismissed(filterOutApplied(await getOpenings({ forceRefresh: true }))));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('✗', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.message || 'Server error');
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Dashboard server: ${url}`);
  console.log('  GET  /                      live dashboard');
  console.log('  POST /api/status            update application status');
  console.log('  GET  /api/openings          list openings (cached 1h)');
  console.log('  POST /api/openings/refresh  force-refresh openings');
  console.log('  Ctrl+C to stop.');
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} ${url}`, () => {});
});
