#!/usr/bin/env node
// fetch-openings.mjs — pull live openings for tracked companies via public ATS APIs.
// Filters: title_filter from portals.yml, location keywords (Canada / US / UK / Remote).
// Output:  output/openings.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(ROOT, 'output/openings.json');
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;

// Qualification rules. See memory feedback_qualification_filter.md.
// Edit these to broaden/narrow what surfaces in Live Openings.

const CANADA_KW = ['canada', 'toronto', 'vancouver', 'ontario', 'british columbia', 'b.c.', ' bc', ' bc,', 'montreal', 'quebec', 'calgary', 'ottawa'];
const US_TARGET_CITIES_KW = ['new york', 'nyc', 'manhattan', 'brooklyn', 'san francisco', ' sf,', ' sf ', 'bay area', 'palo alto', 'mountain view', 'sunnyvale', 'oakland', 'menlo park', 'seattle', 'bellevue', 'redmond'];
const UK_KW = ['london', 'united kingdom', ' uk,', ' uk ', ' uk)', 'england'];
const SINGAPORE_KW = ['singapore'];
const REMOTE_OK_KW = ['us', 'united states', ' usa', 'canada', 'uk', 'united kingdom', 'singapore', 'north america', 'americas', 'global', 'worldwide', 'distributed'];

// Title patterns that disqualify, by category. Order matters: first match wins.
const DQ_LANGUAGE_RE = /\b(french|portuguese|spanish|german|italian|dutch|japanese|korean|polish|russian|swedish|norwegian|danish|finnish)\s+speaking\b|\b(dach|latam|iberia|benelux|nordics|emea|apac)\b/i;
const DQ_DIRECTOR_RE = /\bdirector\b|\bvice president\b|\b(svp|evp|vp)\b|\bhead of\b|\bchief\b/i;
const DQ_PUBLIC_RE = /\bpublic sector\b|\bgovernment\b|\bfederal\b|\bstate\s*(?:&|and)\s*local\b|\bsled\b|\bdef[ae]nce\b|\bdef[ae]nse\b|\bnational security\b|\bcivilian agency\b|\bfcdo\b|\b(dod|nasa|usaid)\b/i;
const DQ_FUNCTION_RE = /\bcounsel\b|\battorney\b|\blegal counsel\b|\bcustomer success\b|\btechnical accounting\b|\bsec reporting\b|\bcontroller\b/i;
// Engineering / IC technical roles (filtered out for non-engineering targeting).
// Carve-out: "sales engineer" allowed via lookbehind; "GTM Engineer" is filtered (off-archetype per user 2026-05-09).
const DQ_ENGINEER_RE = /\b(software|backend|frontend|full[\s-]?stack|product|analytics|data|platform|systems|automation|gtm)\s+engineer\b|\bengineer\b(?!\s*(manager|lead))|\barchitect\b(?!\s*review)|\bsite reliability\b|\bsre\b/i;
// Junior / business-development pre-AE roles.
const DQ_JUNIOR_RE = /\b(bdr|sdr|business development representative|sales development representative|emerging\s+(?:enterprise|account))\b/i;
// Sales operations / strategy / enablement / commissions / finance — not closing roles.
const DQ_SALES_OPS_RE = /\bgtm\s+(?:strategy|business operations|operations|partnerships enablement|enablement|innovation|planning)\b|\bsales operations\b|\brev(?:enue)?\s+ops\b|\benablement (?:lead|manager)\b|\bcommissions\b|\bstrategic finance\b|\bfp\s*&\s*a\b/i;
// Mid-market / commercial AE = below her enterprise/strategic target band.
const DQ_MID_MARKET_RE = /\bmid[\s-]?market\b|\bcommercial\s+account\s+executive\b|\bsmb\b/i;
// Industry verticals that don't match her FSI/cross-industry background.
const DQ_VERTICAL_RE = /\bpharmaceutical\b|\bpharma\b|\bdigital biology\b|\blife sciences\b|\bhealthcare(?!\s+enterprise)\b|\benergy\s*(?:&|and)?\s*utilities\b|\bcybersecurity\b|\bmssp\b/i;
// Management-of-AE roles (not "Account Executive" IC). Catches "Manager, AE" patterns.
const DQ_MANAGER_RE = /^manager,\s+(account|growth|sales|healthcare)|\bmanager,?\s+sales development\b|\bsales\s+manager\b|\bgo[\s-]?to[\s-]?market.*leader\b|\bdigital native gtm leader\b/i;

// Location strings that disqualify outright (foreign geo, no remote target overlap).
const FOREIGN_GEO_RE = /\b(germany|berlin|munich|france|paris|spain|madrid|barcelona|italy|netherlands|amsterdam|sweden|stockholm|norway|denmark|finland|poland|warsaw|portugal|lisbon|japan|tokyo|korea|seoul|india|bangalore|mumbai|china|beijing|shanghai|brazil|argentina|mexico|chile|colombia|philippines|australia|sydney|melbourne|new zealand|south africa|uae|dubai|israel|tel aviv|emea|apac)\b/i;
const LOCATION_PUBLIC_RE = /\bpublic sector\b|\bgovernment\b|\bfederal\b/i;
// Québec / Montréal roles effectively require French fluency even when the title is silent.
const QUEBEC_GEO_RE = /\bmontr[eé]al\b|\bqu[eé]bec\b|\bqc\b/i;
// Title strings that signal a UAE / Middle East regional role even when listed in London.
const TITLE_FOREIGN_RE = /\buae\b|\bdubai\b|\bmiddle east\b|\bmena\b/i;

function classifyLocation(loc) {
  const l = (loc || '').toLowerCase();
  if (!l) return null;
  if (CANADA_KW.some((k) => l.includes(k))) return 'Canada';
  if (UK_KW.some((k) => l.includes(k))) return 'United Kingdom';
  if (SINGAPORE_KW.some((k) => l.includes(k))) return 'Singapore';
  if (US_TARGET_CITIES_KW.some((k) => l.includes(k))) return 'United States';
  if (/\bremote\b|\banywhere\b|\bdistributed\b/.test(l)) {
    if (FOREIGN_GEO_RE.test(l)) return null;
    if (REMOTE_OK_KW.some((k) => l.includes(k))) return 'Remote';
    if (/^remote$|^anywhere$|^distributed$/.test(l.trim())) return 'Remote';
  }
  return null;
}

// Returns the disqualification reason, or null if the title is OK.
function disqualifyReason(title, location) {
  const t = title || '';
  const l = location || '';
  if (DQ_LANGUAGE_RE.test(t)) return 'language';
  if (DQ_DIRECTOR_RE.test(t)) return 'director';
  if (DQ_MANAGER_RE.test(t)) return 'mgmtRole';
  if (DQ_PUBLIC_RE.test(t) || LOCATION_PUBLIC_RE.test(l)) return 'publicSector';
  if (QUEBEC_GEO_RE.test(l)) return 'quebecFrench';
  if (DQ_ENGINEER_RE.test(t)) return 'engineer';
  if (DQ_JUNIOR_RE.test(t)) return 'junior';
  if (DQ_SALES_OPS_RE.test(t)) return 'salesOps';
  if (DQ_MID_MARKET_RE.test(t)) return 'midMarket';
  if (DQ_VERTICAL_RE.test(t)) return 'verticalMismatch';
  if (TITLE_FOREIGN_RE.test(t)) return 'foreignRegion';
  if (DQ_FUNCTION_RE.test(t)) return 'nonTargetFunction';
  return null;
}

// ── ATS detection (mirrors scan.mjs) ────────────────────────────────

function detectApi(company) {
  if (company.workday) {
    const { tenant, site, host } = company.workday;
    return {
      type: 'workday',
      url: `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
      meta: { host, site },
    };
  }
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }
  const url = company.careers_url || '';
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch) {
    return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs` };
  }
  return null;
}

function parseGreenhouse(json, company) {
  return (json.jobs || []).map((j) => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company,
    location: j.location?.name || '',
    updatedAt: j.updated_at || '',
  }));
}
function parseAshby(json, company) {
  return (json.jobs || []).map((j) => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company,
    location: j.location || '',
    updatedAt: j.publishedAt || '',
  }));
}
function parseLever(json, company) {
  if (!Array.isArray(json)) return [];
  return json.map((j) => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company,
    location: j.categories?.location || '',
    updatedAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
  }));
}

function parseWorkday(json, company, meta) {
  return (json.jobPostings || []).map((j) => ({
    title: j.title || '',
    url: meta?.host && j.externalPath ? `https://${meta.host}/en-US/${meta.site}${j.externalPath}` : '',
    company,
    location: j.locationsText || '',
    updatedAt: j.postedOn || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever, workday: parseWorkday };

async function fetchJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchWorkday(url) {
  // Workday paginates at 20/page. Pull up to 100 to keep it bounded.
  const all = [];
  for (let offset = 0; offset < 100; offset += 20) {
    const json = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
    });
    const batch = json.jobPostings || [];
    all.push(...batch);
    if (batch.length < 20) break;
  }
  return { jobPostings: all };
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map((k) => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map((k) => k.toLowerCase());
  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some((k) => lower.includes(k));
    const hasNegative = negative.some((k) => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]).catch((err) => ({ __error: err.message, item: items[idx] }));
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Main ────────────────────────────────────────────────────────────

export async function fetchOpenings() {
  const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'portals.yml'), 'utf8'));
  const titleOk = buildTitleFilter(cfg.title_filter);
  const companies = (cfg.tracked_companies || []).filter((c) => c.enabled !== false);

  const results = await pool(companies, CONCURRENCY, async (c) => {
    const api = detectApi(c);
    if (!api) return { company: c.name, careers_url: c.careers_url, api: null, jobs: [] };
    try {
      const json = api.type === 'workday' ? await fetchWorkday(api.url) : await fetchJson(api.url);
      const jobs = PARSERS[api.type](json, c.name, api.meta);
      return { company: c.name, careers_url: c.careers_url, api: api.type, jobs };
    } catch (err) {
      return { company: c.name, careers_url: c.careers_url, api: api.type, jobs: [], error: err.message };
    }
  });

  // Filter + group
  const grouped = { Canada: [], 'United States': [], 'United Kingdom': [], Singapore: [], Remote: [] };
  const noApi = [];
  let totalKept = 0, totalSeen = 0;
  const dropped = { language: 0, director: 0, mgmtRole: 0, publicSector: 0, quebecFrench: 0, engineer: 0, junior: 0, salesOps: 0, midMarket: 0, verticalMismatch: 0, foreignRegion: 0, nonTargetFunction: 0 };

  for (const r of results) {
    if (!r.api) {
      noApi.push({ company: r.company, careers_url: r.careers_url });
      continue;
    }
    if (r.error) {
      noApi.push({ company: r.company, careers_url: r.careers_url, error: r.error });
      continue;
    }
    for (const j of r.jobs) {
      totalSeen++;
      if (!titleOk(j.title)) continue;
      const reason = disqualifyReason(j.title, j.location);
      if (reason) { dropped[reason]++; continue; }
      const loc = classifyLocation(j.location);
      if (!loc) continue;
      grouped[loc].push(j);
      totalKept++;
    }
  }

  for (const k of Object.keys(grouped)) {
    grouped[k].sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  }

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      companies: companies.length,
      withApi: companies.length - noApi.length,
      totalSeen,
      totalKept,
      dropped,
    },
    grouped,
    noApi,
  };
}

async function main() {
  const data = await fetchOpenings();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
  const { stats, grouped, noApi } = data;
  console.log(`✓ Openings written: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  ${stats.totalKept} kept (of ${stats.totalSeen} seen) across ${stats.withApi} API-backed companies`);
  for (const [loc, jobs] of Object.entries(grouped)) {
    console.log(`  ${loc.padEnd(16)} ${jobs.length}`);
  }
  if (noApi.length) {
    console.log(`  no-api / failed: ${noApi.map((n) => n.company).join(', ')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('✗', err);
    process.exit(1);
  });
}
