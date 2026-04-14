# xtctx UI Redesign

Ground-up redesign of the landing page (`landing/`) and runtime console web UI (`web/`) for xtctx v0.4.

**Date:** 2026-03-06
**Scope:** `landing/` and `web/` packages only. API, MCP, and CLI untouched.

---

## Motivation

The existing UI has three root problems:

1. **Floating card wrappers as structural chrome.** Every section is wrapped in a rounded-corner border box, giving the visual impression of a generic Bootstrap admin template.
2. **No visual hierarchy.** Navigation items, labels, KPI values, and body copy all compete at similar visual weight.
3. **Redundant labeling everywhere.** Eyebrows like "Control plane health" and "Navigation" restate what the surrounding context already communicates.

The result is a UI that reads as template output rather than a deliberate product. The redesign starts from zero.

---

## Design Direction

**Direction C with elements of A** — "The Documentation Tool" aesthetic, modeled on bun.sh and deno.land.

### Core principles

| Principle | Implementation |
|---|---|
| One accent color | `hsl(220 72% 62%)` blue only. No secondary accent, no gradient fills. |
| Functional status colors only | Green/amber/red used solely for status indicators — never for decoration. |
| No card wrappers as layout chrome | Sections are separated by whitespace alone. Borders appear only on interactive elements (buttons, inputs, expand rows). |
| No rounded corners on structural containers | `border-radius` only on small interactive elements: buttons (`rounded-lg`), tags (`rounded-md`). |
| Density is a feature | Information-dense layouts. No wasted vertical space. Dev tools users trust dense UIs. |
| IBM Plex Sans + IBM Plex Mono | Both already in use. IBM Plex Mono used for monospaced values, terminal labels, mechanism numbers, and version strings. |

### Color tokens (unchanged from current)

```css
:root {
  --bg:        222 22% 10%;
  --surface:   222 20% 13%;
  --surface-2: 223 18% 16%;
  --border:    220 18% 26%;
  --text:      215 28% 92%;
  --muted:     218 16% 60%;
  --accent:    220 72% 62%;
}
:root.light-mode {
  --bg:        214 32% 97%;
  --surface:   0 0% 100%;
  --surface-2: 210 24% 97%;
  --border:    216 22% 84%;
  --text:      222 30% 18%;
  --muted:     218 14% 48%;
  --accent:    220 72% 50%;
}
```

---

## Landing Page (`landing/`)

### Layout

- Single column.
- Content max-width: `760px`, centered.
- Outer shell: no outer border. Background is a single tone with very subtle vertical gradient.
- Sections divided by whitespace (`padding-top/bottom: 5rem`) — no `<hr>` or wrapper borders.

### Sections (top to bottom)

#### 1. Header / nav bar (sticky)

```
[xtctx]                    How it works   Quick start    [GitHub ↗]   [Light]
```

- Logo: plain text `xtctx` in `font-semibold`, no border box, no icon.
- Nav: plain text links, no border ghost-button treatment.
- Right cluster: GitHub link (external) + theme toggle (icon or text).

#### 2. Hero

- No two-column layout. Single column.
- Eyebrow: none. The product name in the header already sets context.
- H1: One sentence. Focus on the outcome: resuming in any tool without re-briefing.
- Sub-copy: 1–2 sentences max. No bullet list in the hero.
- CTA: Install command block (primary). "Open runtime UI" link (secondary, plain text, not a button).

**Install block** — terminal chrome with realistic output:

```
$ npx xtctx init
✔ Initialized .xtctx/ in current project
✔ Detected 3 source paths (Claude Code, Cursor, Copilot)
✔ Sync targets written: CLAUDE.md, .cursorrules, .github/copilot-instructions.md

Runtime console → http://localhost:3232
```

#### 3. Social proof bar (immediately after hero, before How it works)

A single horizontal row:

```
Works with: [Claude Code] [Cursor] [Copilot] [Gemini] [Codex CLI]
            ★ 1.2k GitHub stars       ↓ 18k npm downloads
```

- Not in the footer. Placed high enough to validate before the user reads further.
- Logos/icons next to tool names if available as SVG; otherwise plain text badges.
- Star and download counts fetched at build time via GitHub API / npm registry, baked in as static values (no client-side fetch).

#### 4. How it works (animated SVG visualizations)

Label: `How it works` (not "Mechanism").

Four steps, numbered `01` `02` `03` `04` in `IBM Plex Mono` accent color. Each step has:
- Step number (accent mono)
- Title (`text-xl font-semibold`)
- One-sentence description (`text-muted`)
- An SVG diagram or simple CSS animation illustrating the step

**Step diagrams:**

| Step | Visual |
|---|---|
| 01 — Ingest | Animated SVG: conversation log files flowing into a funnel labeled "local index". File icons for Claude Code / Cursor / Copilot. |
| 02 — Index | Static SVG: stacked rows labeled `decisions` / `fixes` / `FAQs` / `conversation chunks` with a magnifier icon. |
| 03 — Sync | Animated SVG: center hub radiating arrows out to `CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`. Arrows pulse on repeat. |
| 04 — Resume | Animated SVG: cursor blink in new terminal → context records flowing in → assistant icon. |

SVGs are inline (not `<img>`), so they inherit CSS color variables and support dark/light theming.

#### 5. Tool switcher — Quick start

A tabbed block with one tab per supported tool:
`Claude Code` | `Cursor` | `Copilot` | `Gemini` | `Codex CLI`

Each tab shows:
- A terminal block with the recall commands specific to that tool
- A terminal block with the writeback commands (e.g. MCP tool calls or CLI commands)

This replaces the generic "daily continuity loop" terminal block.

#### 6. Install and bootstrap (one terminal)

Full install sequence:

```
npm ci
npm --prefix web ci
npm run build

npx xtctx init
npx xtctx sync
npx xtctx serve
```

#### 7. Footer (minimal, single line)

```
xtctx · MIT License · GitHub ↗ · npm ↗
```

No marketing copy. No newsletter. No links grid.

### Analytics

Cloudflare Web Analytics. One `<script>` tag in `landing/index.html`. No cookies. No consent banner required.

```html
<script defer src='https://static.cloudflareinsights.com/beacon.min.js'
  data-cf-beacon='{"token": "YOUR_TOKEN"}'></script>
```

Token to be supplied from Cloudflare dashboard.

---

## Web UI (`web/`)

### Shell layout

```
┌─────────────────────────────────────────────────────────┐
│ [xtctx ▾]  project dropdown          🔍  ● ● ●  [Dark] │  ← topbar
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│  Dash    │                                              │
│  Tools   │         <RouterView />                       │
│  Memory  │                                              │
│          │                                              │
│  ────    │                                              │
│  Health  │                                              │
│  API     │                                              │
└──────────┴──────────────────────────────────────────────┘
```

- **Topbar**: full-width, single `border-bottom`. No shadow, no `bg-surface` — same background color as page, distinguished only by bottom border. Height: `48px`.
- **Sidebar**: `240px` wide. Right border only (no `bg-surface` box). No shadow.
- **Main content area**: full remaining width. `padding: 2rem 2.5rem`.
- No session strip / stat bar below the topbar. Those KPIs belong inside Dashboard.
- No `xt-panel` wrapper on the main content area. Content is directly on `bg`.

### Topbar contents (left → right)

```
[xtctx ▾]   current-project-name        [🔍]   ● runtime healthy   ● 1,204 indexed   ● sync aligned   [Dark]
```

| Element | Detail |
|---|---|
| Project dropdown | `[xtctx ▾]` — clicking opens a dropdown listing all known projects (from workspace scan). Current project name shown beside the logo. Workspace = parent folder (e.g. `~/repos/`) containing multiple project sub-folders, each with `.xtctx/`. Workspace config: `.xtctx-workspace.json`. |
| Search trigger | `🔍` icon button. Opens Cmd+K / Ctrl+K search overlay. |
| Status chips | Three dot-chips: runtime health, indexed record count, tool sync posture. Dot color: green / amber / red. Plain text, no border box. |
| Theme toggle | Plain text `Dark` / `Light`. |

### Sidebar nav (3 items)

```
Dashboard
Tools
Memory
───────────
Health ↗
API ↗
```

- No section labels above nav.
- Active state: left border `4px solid hsl(var(--accent))`, text at full weight.
- Inactive state: `text-muted`, no border.
- Footer: `Health` and `API` as plain `text-xs text-muted` external links. Separated from nav by a `border-top`.
- Theme toggle icon optionally here instead of topbar (TBD — keep in topbar for now for discoverability).

### Search overlay (Cmd+K)

- Full-screen backdrop (`rgba(0,0,0,0.5)`), centered modal, max-width `600px`.
- Input at top, results below.
- Results grouped: `Decisions` / `Fixes` / `FAQs` / `Conversation chunks`.
- `Esc` to close.
- Keyboard navigation (arrow keys + enter).

### Route map

| Route | Sidebar entry | Notes |
|---|---|---|
| `/` | Dashboard | — |
| `/tools` | Tools | Includes Sources section (subsection, not sub-route) |
| `/memory` | Memory | Decisions, fixes, FAQs + tool memory.md files |
| `/activity` | — | Drill-down from Dashboard only. No sidebar link. |

---

### Dashboard (`/`)

Sections (no `xt-eyebrow` labels — section headings carry enough context):

#### System posture card

- One row: posture label chip (healthy / attention needed / degraded) + "Run sync" button + "Refresh" text link.
- KPI grid below: `Detected sources X/Y` · `Tools in sync X/Y` · `Indexed records N` · `Active warnings N`.
- KPIs are plain numbers in `text-2xl font-semibold`, label in `text-xs text-muted` below.

#### Open issues list

- Shown only when `issues.length > 0`.
- Each issue: title + one-line detail + action button. No rounded border boxes — items separated by `border-top` dividers.

#### Recent activity feed

- Shows last 15 ingestion / sync events with relative timestamps (`2 min ago`).
- "View all activity →" link at bottom → navigates to `/activity`.
- Polling: every 30s.

#### Automation actions

- "Run sync all tools" (primary button) · "Manage tools" · "Manage sources" (ghost buttons, inline row).

---

### Tools (`/tools`)

Sources is a **section within this page**, not a separate route.

#### Sources section

- Table: enabled sources with `Path`, `Tool`, `Detected` (✓/✗), `Last ingested`.
- Add / edit source paths inline (no modal).

#### Tools section

- Table or vertical list: one row per supported tool (Claude Code, Cursor, Copilot, Gemini, Codex CLI).
- Columns: `Tool` · `Scope` · `State` (chip: in sync / drifted / missing) · `Last synced` · `▶ Expand`.
- Expand row: shows rendered file content (read-only syntax-highlighted view of the generated CLAUDE.md, .cursorrules, etc.).
- "Sync this tool" button in expand row.

#### Config section

- Effective policy YAML rendered in a read-only code block.
- No separate `/config` route.

---

### Memory (`/memory`)

Two sub-sections toggled by a tab strip at top of page:

| Tab | Content |
|---|---|
| Knowledge | xtctx-managed decisions, fixes, FAQs. Searchable list. Click to expand full record. |
| Tool files | List of `memory.md` / `.clinerules` / etc. files generated by AI tools. Click to view rendered content. |

No separate `/knowledge` or `/search` routes.

---

### Activity (`/activity`)

Full table of all ingestion and sync events. Accessible only via:
- "View all activity →" link on Dashboard.
- Direct URL navigation.

Columns: `Timestamp` · `Event type` · `Source / tool` · `Records affected` · `Status`.

Filtering by: date range, event type, tool. No pagination — virtualized list.

---

## Implementation Scope Summary

### Landing (`landing/`)

- [ ] `src/App.vue` — full rewrite per section spec above
- [ ] `src/style.css` — remove card wrappers, add single-column utilities, tab strip styles
- [ ] `src/components/ToolSwitcher.vue` — new tabbed component for quick start section
- [ ] `src/components/HowItWorks.vue` — new component with inline SVG step diagrams
- [ ] `src/assets/` — SVG assets for tool logos (Claude Code, Cursor, Copilot, Gemini, Codex)
- [ ] `index.html` — Cloudflare Web Analytics script tag

### Web UI (`web/`)

- [ ] `src/App.vue` — full rewrite: new topbar, 3-item sidebar, remove session strip
- [ ] `src/style.css` — full rewrite: remove panel wrapper, new sidebar/topbar tokens
- [ ] `src/pages/Dashboard.vue` — rewrite: KPI grid, issues list, recent activity feed
- [ ] `src/pages/Tools.vue` — rewrite: expand rows with file preview, Sources section embedded
- [ ] `src/pages/Memory.vue` — new page (rename/replace Knowledge.vue)
- [ ] `src/pages/Activity.vue` — rewrite: full event log, no sidebar entry
- [ ] `src/components/SearchOverlay.vue` — new Cmd+K overlay component
- [ ] `src/components/ProjectDropdown.vue` — new topbar project switcher
- [ ] `src/router/index.ts` — update routes: add `/memory`, remove `/sources`, remove `/knowledge`, remove `/search`, keep `/activity`
- [ ] `src/types.ts` — add types for workspace / project list API responses

### API additions required (tracked separately)

- `GET /api/activity` — paginated event log (ingestion + sync events)
- `GET /api/workspace` — list detected projects in workspace
- `GET /api/memory/tool-files` — list tool-generated memory files with content

---

## Open questions

None — all design decisions are resolved. Activity placement confirmed as Dashboard drill-down (no sidebar entry).
