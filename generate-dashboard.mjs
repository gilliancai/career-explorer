#!/usr/bin/env node
// generate-dashboard.mjs — render output/dashboard.html from current data sources.
// Inputs:  data/applications.md, data/pipeline.md, reports/*.md, portals.yml,
//          config/profile.yml, data/scan-history.tsv (optional)
// Output:  output/dashboard.html (self-contained, no external assets)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, 'output');
const OUT_FILE = path.join(OUT_DIR, 'dashboard.html');

// Only positions she has actually applied to (any outcome) appear in the dashboard.
const APPLIED_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']);

// Statuses offered in the in-row dropdown (in flow order).
const STATUS_OPTIONS = ['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded'];

// ─────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────

const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

const escapeHtml = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const slugCompanyInitials = (name) => {
  const words = name.replace(/[^A-Za-z\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
};

const formatDateShort = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const colorFor = (score) => {
  if (score >= 4.5) return 'var(--green)';
  if (score >= 4.0) return 'var(--green)';
  if (score >= 3.5) return 'var(--yellow)';
  if (score >= 3.0) return 'var(--orange)';
  return 'var(--red)';
};

const statusBadgeClass = (status) => {
  const map = {
    Applied: 's-applied',
    Evaluated: 's-evaluated',
    Responded: 's-applied',
    Interview: 's-interview',
    Offer: 's-offer',
    Rejected: 's-skip',
    Discarded: 's-skip',
    SKIP: 's-skip',
  };
  return map[status] || 's-evaluated';
};

// Detect from notes whether an interview happened (recruiter screen, HM round, etc.)
// vs. a resume-screen rejection where no interview took place.
const hadInterview = (notes) => {
  const n = (notes || '').toLowerCase();
  if (!n.includes('interview')) return false;
  if (n.includes('no interview') || n.includes('no-interview')) return false;
  return true;
};

// ─────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────

function parseApplications(md) {
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  // first row = header, second = separator (---|---), rest = data
  const dataLines = lines.slice(2);
  return dataLines
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 9) return null;
      const [num, date, company, role, score, status, pdf, report, notes] = cells;
      const reportPath = (report.match(/\(([^)]+)\)/) || [])[1] || '';
      return {
        num: parseInt(num, 10),
        date,
        company,
        role,
        score: parseFloat(score),
        scoreRaw: score,
        status,
        pdf,
        reportPath,
        notes,
      };
    })
    .filter(Boolean);
}

function parseReport(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const meta = { file: filePath };
  const get = (re) => {
    const m = txt.match(re);
    return m ? m[1].trim() : '';
  };
  const title = get(/^#\s+(.+)$/m);
  const num = (title.match(/^(\d{3})/) || [])[1] || '';
  meta.num = num;
  meta.title = title;
  meta.date = get(/\*\*Date:\*\*\s*([^\n]+)/);
  const scoreStr = get(/\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/);
  meta.score = scoreStr ? parseFloat(scoreStr) : null;
  meta.url = get(/\*\*URL:\*\*\s*([^\n]+)/);
  meta.legitimacy = get(/\*\*Legitimacy:\*\*\s*([^\n]+)/);
  meta.archetype = get(/\|\s*Archetype\s*\|\s*([^|]+?)\s*\|/);
  meta.tldr = get(/\|\s*TL;DR\s*\|\s*([^|]+?)\s*\|/);
  return meta;
}

function parseProfile(yml) {
  const cfg = yaml.load(yml) || {};
  return {
    name: cfg?.candidate?.full_name || '',
    targetTotal: cfg?.compensation?.target_total || '',
    targetBase: cfg?.compensation?.target_base || '',
    locations: cfg?.location_preferences?.open_to_relocate || [],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Derive
// ─────────────────────────────────────────────────────────────────────

function buildActivity(apps, reports) {
  const events = [];
  for (const a of apps) {
    const appliedMatch = a.notes.match(/Applied\s+(\d{4}-\d{2}-\d{2})/);
    if (appliedMatch) {
      events.push({
        date: appliedMatch[1],
        kind: 'applied',
        title: `Application submitted — ${a.company} ${a.role}`,
        sub: a.notes.replace(/Applied\s+\d{4}-\d{2}-\d{2}\.?\s*/, '').slice(0, 120),
      });
    }
    events.push({
      date: a.date,
      kind: a.status === 'SKIP' ? 'skip' : 'eval',
      title: `Evaluation — ${a.company}: ${a.role}`,
      sub: `Score ${a.scoreRaw} · Report #${String(a.num).padStart(3, '0')}`,
    });
  }
  return events.sort((x, y) => y.date.localeCompare(x.date)).slice(0, 8);
}

function buildActions(apps) {
  const actions = [];
  apps
    .filter((a) => a.status === 'Applied')
    .forEach((a) => {
      actions.push({
        icon: '🎯',
        priority: 'HIGH',
        prio: 'p-high',
        title: `Interview prep — ${a.company} ${a.role}`,
        sub: 'STAR stories · domain objections · positioning',
      });
      actions.push({
        icon: '📩',
        priority: 'MED',
        prio: 'p-med',
        title: `Follow-up — ${a.company}`,
        sub: 'Check status if no response in 7–10 days',
      });
    });
  apps
    .filter((a) => a.status === 'Interview')
    .forEach((a) => {
      actions.push({
        icon: '🔥',
        priority: 'HIGH',
        prio: 'p-high',
        title: `Active interview — ${a.company} ${a.role}`,
        sub: 'Confirm next round logistics · refresh STAR bank',
      });
    });
  return actions.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────

function renderStats(apps, profile) {
  const count = (s) => apps.filter((a) => a.status === s).length;
  const applied = apps.length;
  // A response is any reply from the company — including a rejection.
  const responded = apps.filter((a) => ['Responded', 'Interview', 'Offer', 'Rejected'].includes(a.status)).length;
  const interview = count('Interview');
  const offer = count('Offer');
  const inFlight = apps.filter((a) => !['Rejected'].includes(a.status)).length;

  return `
  <div class="stats-grid">
    <div class="stat-card green">
      <div class="stat-label">Applied</div>
      <div class="stat-value" style="color:var(--green)">${applied}</div>
      <div class="stat-sub">${inFlight} still in flight</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-label">Responded</div>
      <div class="stat-value" style="color:var(--blue)">${responded}</div>
      <div class="stat-sub">Companies replied</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-label">Interview</div>
      <div class="stat-value" style="color:var(--accent2)">${interview}</div>
      <div class="stat-sub">Active processes</div>
    </div>
    <div class="stat-card yellow">
      <div class="stat-label">Offer</div>
      <div class="stat-value" style="color:var(--yellow)">${offer}</div>
      <div class="stat-sub">Pending decisions</div>
    </div>
    <div class="stat-card orange">
      <div class="stat-label">Comp Target</div>
      <div class="stat-value" style="color:var(--orange); font-size:22px">${escapeHtml(profile.targetTotal || '$300K CAD')}</div>
      <div class="stat-sub">${escapeHtml(profile.targetBase || '$150K base floor')}</div>
    </div>
  </div>`;
}

function extractRegion(role, notes) {
  // Prefer explicit location in role parens — most reliable.
  const parens = (role || '').match(/\(([^)]+)\)/);
  if (parens) {
    const loc = parens[1].toLowerCase();
    if (/\blondon\b|\buk\b|\bunited kingdom\b/.test(loc)) return 'United Kingdom';
    if (/\bremote\b/.test(loc) && !/\btoronto\b|\bvancouver\b|\bcanada\b/.test(loc)) return 'Remote (US)';
    if (/\btoronto\b|\bvancouver\b|\bmontr[eé]al\b|\bottawa\b|\bcalgary\b|\bcanada\b/.test(loc)) return 'Canada';
    if (/\bnyc\b|\bny\b|\bnew york\b|\bsf\b|\bsan francisco\b|\bbay area\b|\bboston\b|\bseattle\b|\bus\b/.test(loc)) return 'United States';
  }
  // Fall back to the "Applied YYYY-MM-DD. <LOC>, ..." pattern at the start of notes.
  // This resists false positives from references like "IBM Canada" or "#6 Toronto" appearing later.
  const noteHead = (notes || '').match(/^(?:Applied\s+\d{4}-\d{2}-\d{2}\.\s*)?([^.]{1,80})\./);
  const head = noteHead ? noteHead[1].toLowerCase() : (role || '').toLowerCase();
  if (/\blondon\b|\buk\b|\bunited kingdom\b/.test(head)) return 'United Kingdom';
  if (/\bremote\b/.test(head) && !/\btoronto\b|\bvancouver\b|\bcanada\b/.test(head)) return 'Remote (US)';
  if (/\btoronto\b|\bvancouver\b|\bmontr[eé]al\b|\bontario\b|\bottawa\b|\bcalgary\b|\bcanada\b/.test(head)) return 'Canada';
  if (/\bnyc\b|\bny\b|\bnew york\b|\bsf\b|\bsan francisco\b|\bbay area\b|\bboston\b|\bseattle\b/.test(head)) return 'United States';
  return 'Other';
}

function renderActivityCharts(apps) {
  // Only count apps that actually went out (Applied + downstream statuses).
  const sent = apps.filter((a) => APPLIED_STATUSES.has(a.status));
  if (sent.length === 0) {
    return `<div class="charts-grid">
      <div class="chart-card">
        <h3 class="chart-title">Applications by Company</h3>
        <p class="chart-empty">No applications sent yet.</p>
      </div>
      <div class="chart-card">
        <h3 class="chart-title">Applications by Location</h3>
        <p class="chart-empty">No applications sent yet.</p>
      </div>
    </div>`;
  }

  const byCompany = {};
  const byRegion = {};
  const outcomes = {};
  for (const a of sent) {
    byCompany[a.company] = (byCompany[a.company] || 0) + 1;
    const region = extractRegion(a.role, a.notes);
    byRegion[region] = (byRegion[region] || 0) + 1;
    const o = (outcomes[a.company] ||= { total: 0, interview: 0, offer: 0, rejected: 0, awaiting: 0 });
    o.total++;
    if (a.status === 'Interview') o.interview++;
    else if (a.status === 'Offer') o.offer++;
    else if (a.status === 'Rejected') o.rejected++;
    else o.awaiting++; // Applied or Responded — still in play, no final outcome
  }

  const renderBars = (data, accentColor) => {
    const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...entries.map(([, v]) => v));
    return entries
      .map(([label, value]) => {
        const pct = Math.max(6, Math.round((value / max) * 100));
        return `<div class="bar-row">
          <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${accentColor}"></div></div>
          <span class="bar-value">${value}</span>
        </div>`;
      })
      .join('');
  };

  const outcomeRows = Object.entries(outcomes)
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([company, o]) => {
      const cell = (n, color) =>
        `<td class="oc-num"${n ? ` style="color:${color}"` : ''}>${n || '·'}</td>`;
      return `<tr>
        <td class="oc-company">${escapeHtml(company)}</td>
        <td class="oc-num oc-total">${o.total}</td>
        ${cell(o.interview, 'var(--accent2)')}
        ${cell(o.offer, 'var(--yellow)')}
        ${cell(o.rejected, 'var(--red)')}
        ${cell(o.awaiting, 'var(--blue)')}
      </tr>`;
    })
    .join('');

  return `<div class="charts-grid">
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Applications by Company</h3>
        <span class="chart-meta">${sent.length} sent · ${Object.keys(byCompany).length} companies</span>
      </div>
      <div class="bars">${renderBars(byCompany, 'var(--accent)')}</div>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Applications by Location</h3>
        <span class="chart-meta">${Object.keys(byRegion).length} regions</span>
      </div>
      <div class="bars">${renderBars(byRegion, 'var(--accent2)')}</div>
    </div>
  </div>
  <div class="chart-card" style="margin-top:16px">
    <div class="chart-header">
      <h3 class="chart-title">Outcomes by Company</h3>
      <span class="chart-meta">where each company's applications stand</span>
    </div>
    <table class="outcome-table">
      <thead><tr>
        <th>Company</th><th>Applied</th><th>Interview</th><th>Offer</th><th>Rejected</th><th>Awaiting</th>
      </tr></thead>
      <tbody>${outcomeRows}</tbody>
    </table>
  </div>`;
}

function renderStatusSelect(a) {
  const cls = statusBadgeClass(a.status);
  const opts = STATUS_OPTIONS.map(
    (s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${s}</option>`,
  ).join('');
  return `<select class="status-select ${cls}" data-num="${a.num}" data-current="${escapeHtml(a.status)}" onchange="window.__updateStatus(this)">${opts}</select>`;
}

function renderApplicationsTable(apps) {
  if (!apps.length) {
    return `<div class="card" style="margin-bottom:24px">
      <div class="card-title"><span class="dot" style="background:var(--accent)"></span>All Applications</div>
      <p style="color:var(--muted);font-size:12px">No applications yet — paste a JD URL or run /career-ops scan.</p>
    </div>`;
  }
  const rows = apps
    .sort((a, b) => b.num - a.num)
    .map((a) => {
      const pct = Math.round((a.score / 5) * 100);
      const color = colorFor(a.score);
      const appliedMatch = a.notes.match(/Applied\s+(\d{4}-\d{2}-\d{2})/);
      const dateCell = appliedMatch
        ? `${formatDateShort(a.date)}, 2026<br><span style="color:var(--green);font-size:10px">Applied ${formatDateShort(appliedMatch[1])}</span>`
        : `${formatDateShort(a.date)}, 2026`;
      const reportLink = a.reportPath
        ? `<a href="${escapeHtml(a.reportPath)}" style="color:var(--accent);text-decoration:none">#${String(a.num).padStart(3, '0')}</a>`
        : `#${String(a.num).padStart(3, '0')}`;
      return `
        <tr>
          <td style="color:var(--muted);font-weight:700">${reportLink}</td>
          <td><div class="company-cell">${escapeHtml(a.company)}</div></td>
          <td><div class="role-cell">${escapeHtml(a.role)}</div></td>
          <td class="date-cell">${dateCell}</td>
          <td>
            <div class="score-wrap">
              <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>
              <span class="score-num" style="color:${color}">${a.score.toFixed(1)}</span>
            </div>
          </td>
          <td>${renderStatusSelect(a)}</td>
          <td class="pdf-cell">${escapeHtml(a.pdf)}</td>
          <td style="font-size:11px;color:var(--muted);max-width:260px">${escapeHtml(a.notes)}</td>
        </tr>`;
    })
    .join('');

  return `
  <div class="card" style="margin-bottom:24px">
    <div class="card-title">
      <span class="dot" style="background:var(--accent)"></span>
      All Applications <span style="color:var(--muted);font-weight:500;margin-left:8px">${apps.length} total</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Company</th><th>Role</th><th>Date</th><th>Score</th><th>Status</th><th>PDF</th><th>Notes</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderActivity(events) {
  const iconMap = {
    applied: { bg: 'rgba(52,211,153,0.15)', icon: '✅' },
    eval: { bg: 'rgba(167,139,250,0.15)', icon: '🔍' },
    skip: { bg: 'rgba(248,113,113,0.15)', icon: '🚫' },
  };
  const items = events
    .map((e) => {
      const cfg = iconMap[e.kind] || iconMap.eval;
      return `
        <li>
          <div class="tl-icon" style="background:${cfg.bg}">${cfg.icon}</div>
          <div class="tl-content">
            <div class="tl-title">${escapeHtml(e.title)}</div>
            <div class="tl-sub">${escapeHtml(e.sub)}</div>
          </div>
          <div class="tl-time">${formatDateShort(e.date)}<br>${(e.date || '').slice(0, 4)}</div>
        </li>`;
    })
    .join('');
  return `
  <div class="card">
    <div class="card-title">
      <span class="dot" style="background:var(--accent2)"></span>
      Activity Log
    </div>
    <ul class="timeline">${items || '<li><div class="tl-content"><div class="tl-sub">No activity yet.</div></div></li>'}</ul>
  </div>`;
}

function renderFunnel(apps) {
  const counts = {
    Applied: apps.length,
    Responded: apps.filter((a) => ['Responded', 'Interview', 'Offer', 'Rejected'].includes(a.status)).length,
    Interview: apps.filter((a) => ['Interview', 'Offer'].includes(a.status)).length,
    Offer: apps.filter((a) => a.status === 'Offer').length,
  };
  const max = Math.max(...Object.values(counts), 1);

  const funnelRow = (label, count, color) => {
    const pct = Math.max((count / max) * 100, count > 0 ? 8 : 4);
    return `
      <div class="funnel-row">
        <div class="funnel-label">${label}</div>
        <div class="funnel-bar-wrap">
          <div class="funnel-bar" style="width:${pct}%;background:${color}">${count > 0 ? `${count} role${count === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div class="funnel-count" style="color:${count > 0 ? color : 'var(--muted)'}">${count}</div>
      </div>`;
  };

  return `
  <div class="card">
    <div class="card-title">
      <span class="dot" style="background:var(--orange)"></span>
      Pipeline Funnel
    </div>
    <div class="funnel">
      ${funnelRow('Applied', counts.Applied, 'linear-gradient(90deg,var(--green),#22c55e)')}
      ${funnelRow('Responded', counts.Responded, 'var(--blue)')}
      ${funnelRow('Interview', counts.Interview, 'var(--accent2)')}
      ${funnelRow('Offer', counts.Offer, 'var(--yellow)')}
    </div>
  </div>`;
}

// Splits rejections into "interviewed then rejected" (real signal) vs
// "resume-screen rejected" (didn't pass CV filter) — different funnel meaning.
function renderInterviewActivity(apps) {
  const active = apps.filter((a) => a.status === 'Interview' || a.status === 'Offer');
  const interviewedRejected = apps.filter((a) => a.status === 'Rejected' && hadInterview(a.notes));
  const resumeScreenRejected = apps.filter((a) => a.status === 'Rejected' && !hadInterview(a.notes));
  const totalApplied = apps.length;
  const everInterviewed = active.length + interviewedRejected.length;
  const interviewRate = totalApplied ? Math.round((everInterviewed / totalApplied) * 100) : 0;

  const row = (a) =>
    `<li class="iv-row"><span class="iv-co">${escapeHtml(a.company)}</span> <span class="iv-role">${escapeHtml(a.role)}</span></li>`;

  return `
  <div class="card">
    <div class="card-title">
      <span class="dot" style="background:var(--accent2)"></span>
      Interview Activity
      <span style="color:var(--muted);font-weight:500;margin-left:10px;font-size:11px">
        ${everInterviewed} of ${totalApplied} applications converted to an interview · ${interviewRate}% rate
      </span>
    </div>
    <div class="iv-grid">
      <div class="iv-tier">
        <div class="iv-tier-head" style="color:#16a34a">🟢 Active interview — ${active.length}</div>
        <ul class="iv-list">${active.map(row).join('') || '<li class="iv-empty">None right now.</li>'}</ul>
      </div>
      <div class="iv-tier">
        <div class="iv-tier-head" style="color:#f59e0b">🟡 Interviewed → rejected — ${interviewedRejected.length}</div>
        <ul class="iv-list">${interviewedRejected.map(row).join('') || '<li class="iv-empty">None.</li>'}</ul>
      </div>
      <div class="iv-tier">
        <div class="iv-tier-head" style="color:#ef4444">🔴 Resume-screen rejected — ${resumeScreenRejected.length}</div>
        <ul class="iv-list">${resumeScreenRejected.map(row).join('') || '<li class="iv-empty">None.</li>'}</ul>
      </div>
    </div>
  </div>`;
}

function renderScoreChart(reports) {
  const scored = reports.filter((r) => r.score != null).sort((a, b) => b.score - a.score);
  const items = scored
    .map((r) => {
      const pct = (r.score / 5) * 100;
      const color = colorFor(r.score);
      const shortTitle = r.title.replace(/^\d{3}\s*—\s*/, '').slice(0, 40);
      return `
      <div class="css-chart-row">
        <div class="css-chart-label">${escapeHtml(shortTitle)}<br><span>#${r.num}</span></div>
        <div class="css-chart-track">
          <div class="css-chart-bar" style="width:${pct}%;background:${color}">
            <span class="css-chart-val">${r.score.toFixed(1)}</span>
          </div>
        </div>
      </div>`;
    })
    .join('');
  return `
  <div class="card">
    <div class="card-title">
      <span class="dot" style="background:var(--yellow)"></span>
      Score Distribution
    </div>
    <div class="css-chart">
      ${items || '<p style="color:var(--muted);font-size:12px">No scored reports yet.</p>'}
      <div class="css-chart-axis">
        <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
      </div>
    </div>
  </div>`;
}

function renderNotes(apps) {
  const items = apps
    .sort((a, b) => b.score - a.score)
    .map(
      (a) => `
        <li>
          <strong>${escapeHtml(a.company)} — ${escapeHtml(a.role)} (${a.scoreRaw})</strong>
          ${escapeHtml(a.notes)}
        </li>`,
    )
    .join('');
  return `
  <div class="card">
    <div class="card-title">
      <span class="dot" style="background:var(--blue)"></span>
      Application Notes
    </div>
    <ul class="notes-list">${items || '<li>No applications yet.</li>'}</ul>
  </div>`;
}

function renderOpeningsShell() {
  return `
  <div class="card" id="openings-card" style="margin-bottom:24px">
    <div class="card-title">
      <span class="dot" style="background:var(--accent2)"></span>
      Live Openings <span style="color:var(--muted);font-weight:500;margin-left:8px;font-size:11px">tracked companies · public ATS APIs</span>
    </div>
    <div class="openings-toolbar">
      <div class="openings-meta" id="openings-meta">Loading…</div>
      <button class="openings-refresh" id="openings-refresh" type="button">Refresh</button>
    </div>
    <div class="chip-row" id="openings-chips"></div>
    <div id="openings-body"></div>
  </div>`;
}

function renderActions(actions) {
  const items = actions
    .map(
      (a) => `
      <li class="action-item">
        <div class="action-icon">${a.icon}</div>
        <div class="action-text">
          <strong>${escapeHtml(a.title)}</strong>
          <span>${escapeHtml(a.sub)}</span>
        </div>
        <span class="action-priority ${a.prio}">${a.priority}</span>
      </li>`,
    )
    .join('');
  return `
  <div class="card">
    <div class="card-title">
      <span class="dot" style="background:var(--red)"></span>
      Next Actions
    </div>
    <ul class="actions-list">${items}</ul>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f1117; --surface: #1a1d27; --surface2: #22263a; --border: #2e3248;
  --accent: #6c7cff; --accent2: #a78bfa;
  --green: #34d399; --yellow: #fbbf24; --red: #f87171; --orange: #fb923c; --blue: #60a5fa;
  --text: #e2e8f0; --muted: #8892a4; --radius: 12px;
}
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; min-height: 100vh; }
header { background: linear-gradient(135deg, #1a1d27 0%, #0f1117 100%); border-bottom: 1px solid var(--border); padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; }
.header-left h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.header-left h1 span { color: var(--accent); }
.header-left p { color: var(--muted); font-size: 12px; margin-top: 2px; }
.badge-status { background: rgba(52, 211, 153, 0.12); color: var(--green); border: 1px solid rgba(52, 211, 153, 0.3); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.main { padding: 24px 32px; max-width: 1400px; margin: 0 auto; }
.stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; margin-bottom: 24px; }
.charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
.chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
.chart-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
.chart-title { font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: 0.2px; }
.chart-meta { font-size: 11px; color: var(--muted); }
.chart-empty { font-size: 12px; color: var(--muted); padding: 20px 0; text-align: center; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: 120px 1fr 32px; align-items: center; gap: 10px; }
.bar-label { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { background: var(--surface2); border-radius: 4px; height: 8px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease; }
.bar-value { font-size: 12px; color: var(--muted); font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
.outcome-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.outcome-table th { text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.outcome-table th:first-child { text-align: left; }
.outcome-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
.outcome-table tr:last-child td { border-bottom: none; }
.oc-company { font-weight: 700; color: var(--text); }
.oc-num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; color: var(--muted); }
.oc-total { color: var(--text); }
.stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; position: relative; overflow: hidden; }
.stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; border-radius: var(--radius) var(--radius) 0 0; }
.stat-card.blue::before { background: var(--blue); }
.stat-card.green::before { background: var(--green); }
.stat-card.yellow::before{ background: var(--yellow); }
.stat-card.purple::before{ background: var(--accent2); }
.stat-card.orange::before{ background: var(--orange); }
.stat-label { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; }
.stat-value { font-size: 32px; font-weight: 800; margin: 6px 0 2px; letter-spacing: -1px; }
.stat-sub { color: var(--muted); font-size: 11px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
.three-col { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 22px; }
.card-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
.card-title .dot { width: 8px; height: 8px; border-radius: 50%; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
thead th { text-align: left; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
tbody tr { border-bottom: 1px solid var(--border); transition: background 0.15s; }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: var(--surface2); }
tbody td { padding: 12px 12px; vertical-align: middle; }
.company-cell { font-weight: 600; font-size: 13px; }
.role-cell { color: var(--muted); font-size: 12px; max-width: 220px; }
.date-cell { color: var(--muted); font-size: 12px; white-space: nowrap; }
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge-dot { width: 6px; height: 6px; border-radius: 50%; }
.s-applied { background: rgba(96,165,250,0.12); color: var(--blue); border: 1px solid rgba(96,165,250,0.3); }
.s-applied .badge-dot { background: var(--blue); }
.s-evaluated{ background: rgba(251,191,36,0.12); color: var(--yellow); border: 1px solid rgba(251,191,36,0.3); }
.s-evaluated .badge-dot { background: var(--yellow); }
.s-interview{ background: rgba(167,139,250,0.12); color: var(--accent2); border: 1px solid rgba(167,139,250,0.3); }
.s-interview .badge-dot { background: var(--accent2); }
.s-skip { background: rgba(248,113,113,0.12); color: var(--red); border: 1px solid rgba(248,113,113,0.3); }
.s-skip .badge-dot { background: var(--red); }
.s-offer { background: rgba(52,211,153,0.12); color: var(--green); border: 1px solid rgba(52,211,153,0.3); }
.s-offer .badge-dot { background: var(--green); }
.score-wrap { display: flex; align-items: center; gap: 8px; }
.score-bar-track { flex: 1; height: 5px; background: var(--border); border-radius: 4px; overflow: hidden; min-width: 60px; }
.score-bar-fill { height: 100%; border-radius: 4px; }
.score-num { font-size: 12px; font-weight: 700; min-width: 28px; text-align: right; }
.pdf-cell { font-size: 15px; }
.timeline { list-style: none; padding: 0; }
.timeline li { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.timeline li:last-child { border-bottom: none; }
.tl-icon { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; margin-top: 2px; }
.tl-content { flex: 1; }
.tl-title { font-size: 13px; font-weight: 600; }
.tl-sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
.tl-time { color: var(--muted); font-size: 11px; white-space: nowrap; flex-shrink: 0; margin-top: 4px; text-align: right; }
.company-grid { display: flex; flex-direction: column; gap: 12px; }
.company-item { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; display: flex; align-items: center; gap: 14px; }
.company-logo { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 800; flex-shrink: 0; }
.company-info { flex: 1; min-width: 0; }
.company-name { font-weight: 700; font-size: 13px; }
.company-role { color: var(--muted); font-size: 11px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.company-meta { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.company-right { text-align: right; flex-shrink: 0; }
.company-score { font-size: 18px; font-weight: 800; }
.company-score-sub { color: var(--muted); font-size: 10px; }
.funnel { display: flex; flex-direction: column; gap: 8px; }
.funnel-row { display: flex; align-items: center; gap: 10px; }
.funnel-label { color: var(--muted); font-size: 11px; font-weight: 600; width: 80px; text-align: right; }
.funnel-bar-wrap { flex: 1; height: 28px; background: var(--surface2); border-radius: 6px; overflow: hidden; }
.funnel-bar { height: 100%; border-radius: 6px; display: flex; align-items: center; padding: 0 10px; font-size: 12px; font-weight: 700; color: #fff; transition: width 0.8s ease; }
.funnel-count { font-size: 13px; font-weight: 700; width: 24px; text-align: right; }
.notes-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.notes-list li { background: var(--surface2); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; padding: 10px 14px; font-size: 12px; color: var(--muted); }
.notes-list li strong { color: var(--text); display: block; margin-bottom: 2px; }
.actions-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.action-item { display: flex; align-items: flex-start; gap: 10px; background: var(--surface2); border-radius: 8px; padding: 12px 14px; }
.action-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
.action-text { font-size: 12px; flex: 1; }
.action-text strong { display: block; color: var(--text); margin-bottom: 2px; }
.action-text span { color: var(--muted); }
.action-priority { margin-left: auto; flex-shrink: 0; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px; }
.p-high { background: rgba(248,113,113,0.15); color: var(--red); }
.p-med  { background: rgba(251,191,36,0.15); color: var(--yellow); }
.p-low  { background: rgba(96,165,250,0.15); color: var(--blue); }
.target-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.target-item { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 5px; }
.target-item.t-applied { border-color: rgba(96,165,250,0.35); background: rgba(96,165,250,0.05); }
.target-logo { width: 38px; height: 38px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 4px; }
.target-name { font-size: 13px; font-weight: 700; }
.target-focus { font-size: 11px; color: var(--muted); }
.s-target { background: rgba(108,124,255,0.12); color: var(--accent); border: 1px solid rgba(108,124,255,0.3); width: fit-content; margin-top: 4px; }
.s-target .badge-dot { background: var(--accent); }
.s-target2 { background: rgba(136,146,164,0.12); color: var(--muted); border: 1px solid rgba(136,146,164,0.25); width: fit-content; margin-top: 4px; }
.s-target2 .badge-dot { background: var(--muted); }
.css-chart { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
.css-chart-row { display: flex; align-items: center; gap: 12px; }
.css-chart-label { font-size: 11px; color: var(--muted); width: 130px; flex-shrink: 0; line-height: 1.3; text-align: right; }
.css-chart-label span { font-size: 10px; opacity: 0.7; }
.css-chart-track { flex: 1; height: 28px; background: var(--surface2); border-radius: 6px; overflow: hidden; }
.css-chart-bar { height: 100%; border-radius: 6px; display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; min-width: 28px; }
.css-chart-val { font-size: 12px; font-weight: 700; color: #fff; }
.css-chart-axis { display: flex; justify-content: space-between; padding: 4px 0 0 142px; }
.css-chart-axis span { font-size: 10px; color: var(--muted); }
.dash-footer { text-align: center; padding: 20px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); }
.status-select { appearance: none; -webkit-appearance: none; border-radius: 20px; padding: 3px 24px 3px 11px; font-size: 11px; font-weight: 600; cursor: pointer; outline: none; background-color: transparent; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='currentColor' d='M3 4.5l3 3 3-3z'/></svg>"); background-repeat: no-repeat; background-position: right 6px center; background-size: 12px; transition: filter 0.15s; }
.status-select:hover { filter: brightness(1.15); }
.status-select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.status-select option { background: var(--surface); color: var(--text); }
.openings-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.openings-meta { color: var(--muted); font-size: 11px; flex: 1; }
.openings-refresh { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: 18px; font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
.openings-refresh:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.openings-refresh:disabled { opacity: 0.5; cursor: wait; }
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.chip { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); padding: 4px 10px; border-radius: 16px; font-size: 11px; font-weight: 600; cursor: pointer; user-select: none; }
.chip.active { background: rgba(108,124,255,0.18); color: var(--accent); border-color: rgba(108,124,255,0.4); }
.openings-group { margin-top: 16px; }
.openings-group-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.openings-group-count { background: var(--surface2); padding: 2px 8px; border-radius: 12px; font-size: 10px; }
.openings-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.opening-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--surface2); border-radius: 6px; border: 1px solid transparent; transition: border-color 0.15s; }
.opening-row:hover { border-color: var(--border); }
.opening-row.is-new { background: linear-gradient(90deg, rgba(52,211,153,0.12) 0%, var(--surface2) 60%); border-color: rgba(52,211,153,0.3); }
.new-badge { display: inline-block; margin-left: 8px; padding: 1px 6px; background: var(--green); color: #0f1117; font-size: 9px; font-weight: 700; letter-spacing: 0.4px; border-radius: 3px; vertical-align: middle; }
.opening-company { font-size: 11px; font-weight: 700; color: var(--accent); width: 90px; flex-shrink: 0; }
.opening-title { font-size: 12px; flex: 1; min-width: 0; }
.opening-title a { color: var(--text); text-decoration: none; }
.opening-title a:hover { color: var(--accent); }
.opening-loc { color: var(--muted); font-size: 11px; white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.no-api-card { background: var(--surface2); border: 1px dashed var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 12px; font-size: 11px; color: var(--muted); }
.no-api-card a { color: var(--accent); text-decoration: none; }
.no-api-card a:hover { text-decoration: underline; }
.toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; font-size: 12px; color: var(--text); box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 999; opacity: 0; transform: translateY(8px); transition: opacity 0.2s, transform 0.2s; pointer-events: none; max-width: 360px; }
.toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
.toast.error { border-left: 3px solid var(--red); }
.toast.success { border-left: 3px solid var(--green); }
@media (max-width: 1100px) { .stats-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 800px) {
  .two-col, .three-col { grid-template-columns: 1fr; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .main { padding: 16px; }
  header { padding: 16px; flex-direction: column; gap: 10px; align-items: flex-start; }
}

/* Interview Activity */
.iv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 6px; }
.iv-tier { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; min-height: 110px; }
.iv-tier-head { font-size: 12px; font-weight: 700; letter-spacing: 0.02em; margin-bottom: 8px; }
.iv-list { list-style: none; display: flex; flex-direction: column; gap: 4px; padding: 0; margin: 0; }
.iv-row { font-size: 11.5px; line-height: 1.4; color: var(--text); padding: 4px 0; border-bottom: 1px solid var(--border); }
.iv-row:last-child { border-bottom: none; }
.iv-co { font-weight: 600; color: var(--text); }
.iv-role { color: var(--muted); display: block; font-size: 10.5px; margin-top: 1px; }
.iv-empty { font-size: 11px; color: var(--muted); font-style: italic; }
@media (max-width: 900px) { .iv-grid { grid-template-columns: 1fr; } }
`;

function renderHtml(parts, profile, version) {
  const today = new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Job Search Dashboard — ${escapeHtml(profile.name || 'Career Ops')}</title>
  <style>${CSS}</style>
</head>
<body>
<header>
  <div class="header-left">
    <h1>Job Search <span>Dashboard</span></h1>
    <p>${escapeHtml(profile.name || '')} &nbsp;·&nbsp; Enterprise AE → AI/Cloud &nbsp;·&nbsp; Last updated: ${today}</p>
  </div>
  <div class="header-right">
    <span class="badge-status">● Active Search</span>
  </div>
</header>
<div class="main">
  ${parts.stats}
  ${parts.charts}
  ${parts.applications}
  ${parts.openings}
  <div class="two-col">
    ${parts.activity}
    ${parts.funnel}
  </div>
  ${parts.interviewActivity}
  <div class="three-col">
    <div style="display:flex;flex-direction:column;gap:16px">
      ${parts.scoreChart}
      ${parts.notes}
    </div>
    ${parts.actions}
  </div>
</div>
<div class="dash-footer">
  career-ops ${escapeHtml(version)} &nbsp;·&nbsp; ${escapeHtml(profile.name || '')} &nbsp;·&nbsp; Generated ${today}
  &nbsp;·&nbsp; Target: ${escapeHtml(profile.targetTotal || '')}
</div>
<div id="toast" class="toast"></div>
<script>
(function () {
  const toast = document.getElementById('toast');
  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.className = 'toast show ' + (kind || '');
    setTimeout(() => { toast.className = 'toast'; }, 3500);
  }
  // ── Live Openings ───────────────────────────────────────────────
  let openingsCache = null;
  const activeCompanies = new Set();

  function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function renderOpenings(data) {
    const meta = document.getElementById('openings-meta');
    const body = document.getElementById('openings-body');
    const chips = document.getElementById('openings-chips');
    if (!body) return;

    const ts = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—';
    const hidden = data.stats.hiddenApplied || 0;
    const dismissed = data.stats.hiddenDismissed || 0;
    const dr = data.stats.dropped || {};
    const droppedTotal = (dr.language || 0) + (dr.director || 0) + (dr.publicSector || 0) + (dr.quebecFrench || 0) + (dr.nonTargetFunction || 0) + hidden + dismissed;
    const bits = [];
    if (hidden) bits.push(hidden + ' already applied');
    if (dismissed) bits.push(dismissed + ' dismissed');
    if (dr.language) bits.push(dr.language + ' language');
    if (dr.director) bits.push(dr.director + ' director');
    if (dr.publicSector) bits.push(dr.publicSector + ' public sector');
    if (dr.quebecFrench) bits.push(dr.quebecFrench + ' Québec (French)');
    if (dr.nonTargetFunction) bits.push(dr.nonTargetFunction + ' off-archetype');
    const suffix = bits.length ? ' · ' + droppedTotal + ' excluded before display (' + bits.join(' · ') + ')' : '';
    const newCount = data.stats.newSinceSnapshot || 0;
    const newBit = newCount > 0 ? ' · 🆕 ' + newCount + ' new since last hourly check' : '';
    meta.textContent = 'Showing ' + data.stats.totalKept + ' qualified openings · ' + data.stats.withApi + ' API-backed companies' + suffix + newBit + ' · refreshed ' + ts;

    const allCompanies = new Set();
    for (const jobs of Object.values(data.grouped)) for (const j of jobs) allCompanies.add(j.company);
    const sortedCompanies = [...allCompanies].sort();
    if (activeCompanies.size === 0) sortedCompanies.forEach((c) => activeCompanies.add(c));

    chips.innerHTML = sortedCompanies.map((c) => {
      const on = activeCompanies.has(c);
      return '<span class="chip ' + (on ? 'active' : '') + '" data-company="' + escape(c) + '">' + escape(c) + '</span>';
    }).join('');
    chips.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => {
        const c = el.dataset.company;
        if (activeCompanies.has(c)) activeCompanies.delete(c); else activeCompanies.add(c);
        renderOpenings(openingsCache);
      });
    });

    let html = '';
    for (const [loc, jobs] of Object.entries(data.grouped)) {
      const filtered = jobs.filter((j) => activeCompanies.has(j.company));
      if (!filtered.length) continue;
      html += '<div class="openings-group"><div class="openings-group-title">' + escape(loc) + '<span class="openings-group-count">' + filtered.length + '</span></div>';
      html += '<ul class="openings-list">';
      for (const j of filtered) {
        const newBadge = j.isNew ? '<span class="new-badge" title="Posted since last hourly check">NEW</span>' : '';
        html += '<li class="opening-row' + (j.isNew ? ' is-new' : '') + '">'
          + '<span class="opening-company">' + escape(j.company) + '</span>'
          + '<span class="opening-title"><a href="' + escape(j.url) + '" target="_blank" rel="noopener">' + escape(j.title) + '</a>' + newBadge + '</span>'
          + '<span class="opening-loc">' + escape(j.location) + '</span>'
          + '</li>';
      }
      html += '</ul></div>';
    }
    if (data.noApi && data.noApi.length) {
      html += '<div class="no-api-card"><strong>Manual scan needed</strong> — these companies don\\'t expose a public ATS API: '
        + data.noApi.map((n) => '<a href="' + escape(n.careers_url || '#') + '" target="_blank" rel="noopener">' + escape(n.company) + '</a>').join(' · ')
        + '</div>';
    }
    body.innerHTML = html || '<p style="color:var(--muted);font-size:12px">No openings match the active filters.</p>';
  }

  async function loadOpenings(force) {
    const btn = document.getElementById('openings-refresh');
    const meta = document.getElementById('openings-meta');
    if (btn) btn.disabled = true;
    if (meta && force) meta.textContent = 'Refreshing…';
    try {
      const url = force ? '/api/openings/refresh' : '/api/openings';
      const opts = force ? { method: 'POST' } : {};
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      openingsCache = await res.json();
      renderOpenings(openingsCache);
    } catch (err) {
      if (meta) meta.textContent = 'Failed to load openings: ' + (err.message || err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (location.protocol !== 'file:') {
    document.addEventListener('DOMContentLoaded', () => {
      loadOpenings(false);
      const btn = document.getElementById('openings-refresh');
      if (btn) btn.addEventListener('click', () => loadOpenings(true));
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      const meta = document.getElementById('openings-meta');
      if (meta) meta.textContent = 'Read-only mode. Run \`npm run dashboard:serve\` to load live openings.';
    });
  }

  window.__updateStatus = async function (el) {
    const num = el.dataset.num;
    const previous = el.dataset.current;
    const next = el.value;
    if (next === previous) return;
    if (location.protocol === 'file:') {
      el.value = previous;
      showToast('Read-only mode. Run \`npm run dashboard:serve\` to enable updates.', 'error');
      return;
    }
    const note = (window.prompt('Optional note for ' + next + ' (or leave blank):', '') || '').trim();
    try {
      const res = await fetch('/api/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num: Number(num), status: next, note }),
      });
      if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
      showToast('Updated #' + String(num).padStart(3, '0') + ' → ' + next, 'success');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      el.value = previous;
      showToast('Update failed: ' + (err.message || err), 'error');
    }
  };
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

export function buildHtml() {
  const allApps = parseApplications(read('data/applications.md'));
  const apps = allApps.filter((a) => APPLIED_STATUSES.has(a.status));
  const profile = parseProfile(read('config/profile.yml'));
  const version = read('VERSION').trim() || 'v?';

  const allReports = fs
    .readdirSync(path.join(ROOT, 'reports'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseReport(path.join(ROOT, 'reports', f)));

  const appReportPaths = new Set(apps.map((a) => path.basename(a.reportPath)));
  const reports = allReports.filter((r) => appReportPaths.has(path.basename(r.file)));

  const events = buildActivity(apps, reports);
  const actions = buildActions(apps);

  const parts = {
    stats: renderStats(apps, profile),
    charts: renderActivityCharts(apps),
    applications: renderApplicationsTable(apps),
    activity: renderActivity(events),
    funnel: renderFunnel(apps),
    interviewActivity: renderInterviewActivity(apps),
    scoreChart: renderScoreChart(reports),
    notes: renderNotes(apps),
    actions: renderActions(actions),
  };

  parts.openings = renderOpeningsShell();

  return {
    html: renderHtml(parts, profile, version),
    stats: { applied: apps.length, total: allApps.length, reports: reports.length },
  };
}

function main() {
  const { html, stats } = buildHtml();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html);
  console.log(`✓ Dashboard written: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  ${stats.applied} applied (of ${stats.total} tracked) · ${stats.reports} reports linked`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
