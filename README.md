# Career-Ops

An AI-powered, CLI-agnostic job-search command center. Paste a job URL or description and it evaluates fit against your CV, generates a tailored ATS-ready PDF, tracks the application, scans portals for new roles, and preps you for interviews — all from your terminal, with you making every final call.

Runs on any AI coding CLI that follows the [open agent skill standard](https://agentskills.io): Claude Code, Codex, Gemini CLI, OpenCode, Qwen, and others.

> **This is a filter, not a spray-and-pray tool.** It helps you find the few roles worth your time and recommends against applying to weak-fit ones. It never submits an application — you always review and decide.

---

## Setup

```bash
# 1. Clone and install
git clone <your-repo-url> career-ops
cd career-ops && npm install
npx playwright install chromium        # for PDF generation + portal scanning

# 2. Validate prerequisites
npm run doctor

# 3. Create your config from the templates
cp config/profile.example.yml config/profile.yml     # your identity, targets, comp
cp templates/portals.example.yml portals.yml         # companies to scan
#  → create cv.md in the project root (your CV in markdown)

# 4. Open your CLI in this directory and let it onboard you
claude        # or: gemini / opencode / codex
```

On first run, the assistant detects missing files and walks you through onboarding. See [`docs/SETUP.md`](docs/SETUP.md) for the full guide.

## Usage

A single command with multiple modes:

```
/career-ops                → show all commands
/career-ops {paste a JD}   → full pipeline: evaluate + PDF + tracker
/career-ops scan           → scan portals for new roles
/career-ops pdf            → generate an ATS-optimized CV
/career-ops apply          → assist filling an application form (never auto-submits)
/career-ops tracker        → application status overview
/career-ops batch          → evaluate many roles in parallel
/career-ops interview-prep → company-specific interview prep
```

Optional terminal dashboard:

```bash
cd dashboard && go build -o career-dashboard . && ./career-dashboard --path ..
```

## How your data is organized

The repo separates a **System Layer** (scripts, modes, templates — safe to update) from a **User Layer** (your CV, profile, tracker, reports — never touched by updates). See [`DATA_CONTRACT.md`](DATA_CONTRACT.md).

**Your personal files are gitignored by default.** You create them from the committed `*.example` / `*.template` scaffolding, and your CV, profile, reports, and generated PDFs stay local. If you keep your fork **public**, make sure your tracker, pipeline, and story-bank don't contain anything you wouldn't post publicly — most people fork to a **private** repo once they add real data.

## Credit & License

Based on [career-ops](https://github.com/santifer/career-ops) by Santiago Fernández de Valderrama, used under the [MIT License](LICENSE). Modifications © 2026 Gillian Cai.

MIT lets you use, modify, and redistribute this freely; the only requirement is keeping the [`LICENSE`](LICENSE) file (its copyright notice) intact. If you plan to distribute this as your own branded product, consider renaming it to avoid implying endorsement by the original project.
