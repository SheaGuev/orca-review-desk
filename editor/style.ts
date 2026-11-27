// The guide tab's styles, built on Orca's frame variables so it follows the app theme.
import { CATEGORIES } from "../src/breakdown/categories";
import { CATEGORY_COLORS, GIT_COLORS, type Mode } from "../src/breakdown/colors";
import { ICON_PALETTE } from "../src/breakdown/icons/palette";
import { CODE_THEMES } from "./code-themes";

/** Changes uses Diff Breakdown's colours: categories, git's modified, and Catppuccin for icons. */
const ICON_FLAVOURS: Record<Mode, keyof typeof ICON_PALETTE> = { dark: "mocha", light: "latte" };
const changeColours = (mode: Mode) =>
  [
    ...Object.entries(CATEGORY_COLORS[mode]).map(([id, c]) => `--c-${id}: ${c};`),
    ...Object.entries(ICON_PALETTE[ICON_FLAVOURS[mode]]).map(([n, c]) => `--ctp-${n}: ${c};`),
    `--mod: var(--orca-git-decoration-modified, ${GIT_COLORS[mode].modified});`,
  ].join(" ");

export const STYLE = `
:root {
  --bg: var(--orca-background, #fff);
  --fg: var(--orca-foreground, #1c1c1a);
  --card: var(--orca-card, #f5f5f3);
  --line: var(--orca-border, #d6d6d1);
  --muted: var(--orca-muted-foreground, #5a5a55);
  --accent: var(--orca-primary, #2457c5);
  --accent-fg: var(--orca-primary-foreground, #fff);
  --danger: var(--orca-destructive, #a1262b);
  /* Orca's own roles for these, so a theme that sets them apart is followed. */
  --ring: var(--orca-ring, var(--accent));
  --hover: var(--orca-accent, color-mix(in srgb, var(--fg) 8%, transparent));
  --hover-fg: var(--orca-accent-foreground, var(--fg));
  --card-fg: var(--orca-card-foreground, var(--fg));
  --popover: var(--orca-popover, var(--card));
  --popover-fg: var(--orca-popover-foreground, var(--card-fg));
  --input: var(--orca-input, var(--line));
  --radius: var(--orca-radius, 8px);
  --check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  --mono: var(--orca-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  --sans: var(--orca-font-sans, Inter, system-ui, sans-serif);
  --add: #1d7a3a;
  color-scheme: light;
  --warn: #9a5b00;
}
:root { ${changeColours("light")} }
html.dark { ${changeColours("dark")} }
html.dark {
  color-scheme: dark;
  --add: #6fd08d; --warn: #f2c26b;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--sans); }
h1 { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; }
h2 { margin: 0; font-size: 15px; font-weight: 600; }
h3 { margin: 0; font-size: 14px; font-weight: 600; }
h2.inline { display: inline; }
p { margin: 0; }
.page { max-width: 760px; margin: 0 auto; padding: 28px 24px calc(var(--bar-h, 0px) + 32px); display: flex; flex-direction: column; gap: 22px; }
.stack-sm { display: flex; flex-direction: column; gap: 6px; }
.stack-xs { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.row { display: flex; gap: 8px; align-items: center; }
.row.wrap { flex-wrap: wrap; }
.row.baseline { align-items: baseline; flex-wrap: wrap; }
.eyebrow { font: 500 11px/16px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.mono { font-family: var(--mono); }
.add { color: var(--add); }
.del { color: var(--danger); }
.meta { line-height: 1.8; }
.section { display: flex; flex-direction: column; gap: 10px; }
.tag { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); font: 500 11px var(--mono); white-space: nowrap; justify-self: start; align-self: start; }
.tag.new { border-color: var(--accent); color: var(--accent); }
.tag.ok { border-color: var(--add); color: var(--add); }
.tag.bad { border-color: var(--danger); color: var(--danger); }
.tag.level.high, .tag.sev.blocker, .tag.sev.major { border-color: var(--danger); color: var(--danger); }
.tag.level.medium, .tag.sev.minor { border-color: var(--warn); color: var(--warn); }
.tag.level.low { border-color: var(--add); color: var(--add); }
.file, .link { background: none; border: 0; padding: 2px 0; color: var(--accent); cursor: pointer; text-align: left; font: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 3px; }
.file { min-height: 24px; font: 500 12.5px var(--mono); word-break: break-all; align-self: start; }
.file:hover, .link:hover { text-decoration-color: currentColor; }
code { font: 0.92em var(--mono); background: color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 4px; padding: 1px 4px; }
button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.more > summary { display: flex; align-items: center; gap: 4px; min-height: 24px; cursor: pointer; color: var(--accent); font-size: 12.5px; width: max-content; list-style: none; }
.more > summary::-webkit-details-marker { display: none; }
.more > summary::before { content: "▸"; }
.more[open] > summary::before { content: "▾"; }
.more[open] > summary { margin-bottom: 4px; }
.detail { display: flex; flex-direction: column; gap: 8px; padding: 8px 12px; border-left: 2px solid var(--line); }
.headline { font-weight: 500; }
.checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-width: 80ch; }
.check { display: flex; gap: 10px; align-items: flex-start; min-height: 24px; cursor: pointer; }
.check input { width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--accent); flex: none; }
.points { display: flex; flex-direction: column; }
.point { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 4px 12px; padding: 10px 0; border-top: 1px solid var(--line); }
.point:last-child { border-bottom: 1px solid var(--line); }
.point .label { font: 500 11px/22px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
/* Changes, drawn as Diff Breakdown draws a branch. One grid (rows are subgrids), so the share and
   line counts of categories and files line up in columns. */
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.bd { display: flex; flex-direction: column; gap: 10px; }
.bd-grid { display: grid; grid-template-columns: 14px 16px minmax(0, 1fr) auto auto auto auto auto; column-gap: 8px; }
.bd-refs { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: baseline; }
.bd-branch { grid-column: 1 / 6; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { grid-column: 1 / -1; margin: 8px 0 10px; display: flex; gap: 2px; height: 10px; border-radius: 5px; overflow: hidden; background: color-mix(in srgb, var(--fg) 8%, transparent); }
.bd-seg { min-width: 4px; flex-basis: 0; }
${CATEGORIES.map(({ id }) => `.c-${id} { background: var(--c-${id}); }`).join("\n")}
.bd-list, .bd-group, .bd-files, .bd-file, .bd-head { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; }
.bd-group { border-top: 1px solid var(--line); }
.bd-group:last-child { border-bottom: 1px solid var(--line); }
.bd-head { min-height: 32px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
.bd-head:hover { background: var(--hover); color: var(--hover-fg); }
.bd-head .chev { color: var(--muted); transition: transform 120ms; }
.bd-head[aria-expanded="true"] .chev { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .bd-head .chev { transition: none; } }
.bd-dot { width: 10px; height: 10px; border-radius: 3px; justify-self: center; }
.bd-cat { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.bd-group.generated .bd-cat { font-weight: 500; color: var(--muted); }
.num { font: 12px var(--mono); text-align: right; white-space: nowrap; }
.bd-share { text-align: right; white-space: nowrap; }
.bd-list, .bd-files { list-style: none; margin: 0; padding: 0; }
.bd-files { padding-bottom: 6px; }
.bd-files[hidden] { display: none; }
.bd-file { min-height: 28px; }
.bd-icon { grid-column: 2; display: flex; }
.bd-name { display: flex; gap: 8px; align-items: baseline; min-width: 0; min-height: 24px; padding: 2px 0; border: 0; background: none; color: var(--fg); font: inherit; text-align: left; overflow: hidden; }
button.bd-name { cursor: pointer; }
button.bd-name:hover .fname { text-decoration: underline; text-underline-offset: 3px; }
.fname { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.fdir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.bd-name.gone .fname { text-decoration: line-through; color: var(--muted); }
.bd-status { width: 14px; text-align: center; font: 600 12px var(--mono); }
.s-A { color: var(--add); }
.s-D { color: var(--danger); }
.s-M, .s-R, .s-C, .s-T, .s-U { color: var(--mod); }
.bd-where { justify-self: end; white-space: nowrap; }
.bd-where.off { color: var(--muted); }
span.bd-where { padding: 0 10px; }
.bd-more { grid-column: 3 / -1; padding: 4px 0; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 10px 0; border-top: 1px solid var(--line); align-items: start; }
.rows > li.claim { grid-template-columns: 88px minmax(0, 1fr); gap: 4px 14px; }
.rows > li.claim .measure { min-width: 0; overflow-wrap: anywhere; }
.rows > li.claim .measure p { margin: 4px 0 0; }
.flows { display: flex; flex-wrap: wrap; gap: 14px; }
.flow-col { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px; border-radius: var(--radius); border: 1px dashed var(--line); }
.flow-col.after { border: 1px solid var(--accent); }
.flow-col .eyebrow { align-self: flex-start; margin-bottom: 4px; }
.step { width: 100%; max-width: 320px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); text-align: center; font-size: 13px; display: flex; gap: 8px; justify-content: center; align-items: center; flex-wrap: wrap; }
.step.changed { border-color: var(--accent); }
.arrow { color: var(--muted); line-height: 1; }
.coverage { padding: 8px 12px; border: 1px solid var(--warn); border-radius: 6px; }
.footer { border-top: 1px solid var(--line); padding-top: 12px; }
.notice:empty { display: none; }
.banner { border: 1px solid var(--warn); border-radius: var(--radius); padding: 10px 14px; }
.banner.bad { border-color: var(--danger); color: var(--danger); display: flex; flex-direction: column; gap: 6px; }
.banner ul { margin: 0; padding-left: 18px; }
.raw { font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; background: var(--card); color: var(--card-fg); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; margin: 0; }
.row.between { justify-content: space-between; }
.btn { min-height: 30px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: 500 13px var(--sans); cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn.sm { min-height: 28px; padding: 0 10px; font-size: 12.5px; }
.btn.ghost { border-color: transparent; background: none; }
.btn.ghost:hover { border-color: var(--line); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.btn.icon { min-width: 28px; padding: 0; font-size: 16px; line-height: 1; }
.link.small { font-size: 12.5px; }
.input { width: 100%; font: 13px/1.5 var(--sans); color: var(--fg); background: var(--bg); border: 1px solid var(--input); border-radius: 6px; padding: 6px 8px; resize: vertical; }
.input[aria-invalid="true"] { border-color: var(--danger); }
.field-error { color: var(--danger); }
.field-error:empty { display: none; }
/* The comment composer: under a line (indented to the code by .annot), a range, or a file header. */
.composer { display: flex; flex-direction: column; gap: 6px; max-width: 760px; padding: 10px 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--bg); }
.composer:focus { outline: none; }
.composer:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.composer-title { font-weight: 600; font-size: 13px; }
.input.autosize { resize: none; overflow-y: hidden; }
.composer-foot { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between; }
.suggestion { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-left: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 0 6px 6px 0; margin-top: 4px; }
/* Right padding keeps the actions clear of Orca's own floating button at the tab's bottom right. */
.review-bar { position: fixed; z-index: 10; left: 0; right: 0; bottom: 0; background: var(--card); color: var(--card-fg); border-top: 1px solid var(--line); padding: 10px 72px 10px 24px; display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; box-shadow: 0 -4px 16px rgb(0 0 0 / .12); }
.bar-line { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
/* Posting: a choice of verdict, what a press will send, and the one button that sends it. */
.verdict-choice { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; }
.verdict-option { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; cursor: pointer; }
.verdict-option input { margin: 0; accent-color: var(--accent); }
.post { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--line); }
.post p { margin: 0; }
.post-unread { color: var(--warn); }
.post-button { display: inline-flex; align-items: center; gap: 8px; }
/* While the review is on its way: the fields dim and a ring turns in the button. */
.review-bar [inert] { opacity: .55; }
.spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
.posted-title { color: var(--add); }
.review-status:empty { display: none; }
.review-status { font-size: 12.5px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* A list of files outside the stops (Not in the tour): each opens its diff. */
.file-rows { list-style: none; margin: 0; padding: 0; }
.file-rows > li { border-top: 1px solid var(--line); padding: 6px 0; }

/* The tour. Narrative text keeps a readable measure; code takes the width. */
.measure { max-width: 72ch; }
.nowrap { white-space: nowrap; }
.invisible { visibility: hidden; }
.overview { max-width: 1240px; }
/* Overview order: title and the way in; what / why / impact beside the changes; findings; tour. */
.ov-head { display: flex; flex-wrap: wrap; gap: 12px 32px; align-items: flex-start; justify-content: space-between; }
.ov-title { flex: 1 1 420px; min-width: 0; }
.ov-title h1 { max-width: 40ch; }
.start-actions { flex: none; padding-top: 2px; }
.restart-confirm .btn.danger { color: var(--danger); border-color: var(--danger); }
.meta .tag { display: inline-flex; vertical-align: baseline; height: 20px; }
.since { display: flex; flex-direction: column; gap: 6px; margin-top: -10px; }
.since-line .link { white-space: nowrap; margin-left: 4px; }
.since-rows { list-style: none; margin: 0; padding: 0; font-size: 13.5px; color: var(--fg); }
.since-row { display: grid; grid-template-columns: minmax(0, 14rem) minmax(0, 1fr) auto; gap: 4px 12px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--line); }
.since-row:last-child { border-bottom: 1px solid var(--line); }
.since-row .mono { overflow-wrap: anywhere; }
.since-note .tag { margin-left: 8px; }
@media (max-width: 640px) { .since-row { grid-template-columns: minmax(0, 1fr) auto; } .since-row .since-note { grid-column: 1 / -1; grid-row: 2; } }
.ov-top { display: flex; flex-direction: column; gap: 22px; }
html.w-cols .ov-top { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 48px; align-items: start; }
.head-actions { flex: none; }
.provenance { margin: 0; }
html.w-cols .head-actions { align-items: flex-end; }
html.w-cols .provenance { text-align: right; }
.risk-card { border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: var(--radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.risk-card.high { border-left-color: var(--danger); }
.risk-card.medium { border-left-color: var(--warn); }
.risk-card.low { border-left-color: var(--add); }
.risk-card h2.tag { font-size: 12px; margin: 0; }
.risk-card .risk-headline { margin: 0; font-weight: 500; }
.risk-card .section { gap: 6px; }
.ov-side, .ov-main { display: flex; flex-direction: column; gap: 22px; }
.finding-list { list-style: none; margin: 0; padding: 0; }
.finding-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 4px 12px; align-items: start; padding: 8px 0; border-top: 1px solid var(--line); }
.finding-row[hidden] { display: none; }
.finding-row:last-child { border-bottom: 1px solid var(--line); }
.finding-row > .tag { justify-self: start; margin-top: 1px; }
.finding-row > .btn { justify-self: end; white-space: nowrap; }
.finding-list + .btn { align-self: start; }
/* The overview's tour: every stop as a card in reading order, across the page's full width. */
.tour-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.tour-steps li { display: flex; }
.tour-step { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: none; color: var(--fg); font: inherit; text-align: left; cursor: pointer; transition: background-color 150ms; }
.tour-step:hover { background: var(--hover); color: var(--hover-fg); }
.tour-step:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
/* A skim stop is dashed; its label says "skim" in words. */
.tour-step.skim { border-style: dashed; }
/* Where the tour starts or resumes: the accent outline, and the mark says it in words. */
.tour-step.here { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.tour-step-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font: 600 12px var(--mono); color: var(--muted); }
.tour-step-changed { font: 500 12px var(--sans); color: var(--muted); }
.tour-step-mark { font: 600 12px var(--sans); }
.tour-step-mark.start, .tour-step-mark.resume { color: var(--accent); }
.tour-step-mark.seen { color: var(--add); }
.tour-step-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tour-step-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 500; }
.tour-step-text.mono { font: 500 13px var(--mono); }
.tour-step-main .tag { flex: none; }
@media (prefers-reduced-motion: reduce) { .tour-step { transition: none; } }
/* The wrap-up's chips for the stops not seen yet: a set, not a sequence. */
.route { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.route li { display: inline-flex; align-items: center; }
.route-stop { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius); background: none; color: var(--fg); font: 500 12.5px var(--mono); white-space: nowrap; cursor: pointer; }
.route-stop:hover { background: var(--hover); color: var(--hover-fg); }
.route-stop.skim { border-style: dashed; color: var(--muted); }
.route-num { font-weight: 600; color: var(--muted); }
.route-seen { color: var(--add); }
.route-skipped { margin: 10px 0 0; }
/* A stop's depth in words: deep stops outlined in the accent, skim stops plain. */
.tag.skip { color: var(--fg); }

.tour { display: block; }
.rail { display: none; }
html.w-rail .tour { display: grid; grid-template-columns: var(--rail-w, 290px) minmax(0, 1fr); align-items: start; }
html.w-rail { scroll-padding-top: 72px; }
html.w-rail .rail { display: flex; flex-direction: column; position: sticky; top: 0; height: calc(100vh - var(--bar-h, 0px)); border-right: 1px solid var(--line); }
.rail-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 8px 0 12px; }
/* The open rail on a narrow tab lies over the page, so the code keeps its width. */
html.w-rail-over .tour { display: block; }
html.w-rail-over .rail { position: fixed; left: 0; top: 0; z-index: 6; width: var(--rail-w, 290px); background: var(--bg); box-shadow: 8px 0 24px rgb(0 0 0 / .28); }
.rail-resize { position: absolute; top: 0; right: -4px; z-index: 2; width: 8px; height: 100%; cursor: col-resize; touch-action: none; }
.rail-resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; transition: background-color 120ms; }
.rail-resize:hover::after, .rail-resize:focus-visible::after, html.rail-dragging .rail-resize::after { background: var(--accent); }
.rail-resize:focus-visible { outline: none; }
html.rail-dragging, html.rail-dragging * { cursor: col-resize !important; user-select: none; }
.rail-toggle { flex: none; }
.rail-toggle-icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linejoin: round; display: block; margin: auto; }
.rail-toggle[aria-expanded="true"] { color: var(--accent); }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.step-link { display: flex; gap: 8px; align-items: center; width: 100%; min-height: 28px; padding: 3px 8px; border: 0; border-radius: 6px; background: none; color: inherit; font: 13px var(--sans); text-align: left; cursor: pointer; }
.step-link:hover { background: var(--hover); color: var(--hover-fg); }
.step-link[aria-current="step"] { background: var(--hover); color: var(--hover-fg); font-weight: 600; }
.step-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px var(--mono); }
.step-name.plain { font: 13px var(--sans); }
.step-more { flex: none; color: var(--muted); font: 11.5px var(--mono); }
/* A stop's pending comments: a count in a small accent pill (its button's name says it too). */
.step-pending { flex: none; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: var(--accent-fg); font: 600 11px/18px var(--sans); text-align: center; }
.step-pending[hidden] { display: none; }
.mark { width: 18px; flex: none; text-align: center; color: var(--muted); font: 12px var(--mono); }
.mark.seen { color: var(--add); }
.mark.now { color: var(--accent); }
.mark.flag { width: auto; color: var(--warn); }
.tour-main { min-width: 0; padding-bottom: calc(var(--bar-h, 0px) + 32px); }
.topbar { position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 24px; background: var(--bg); border-bottom: 1px solid var(--line); }
/* Prev and Next stay at the right edge, so they don't move as the step label's width changes. */
.topbar-nav { margin-left: auto; }
.topbar-label { display: none; font-weight: 600; font-size: 13px; }
.topbar .exit { flex: none; }
html.w-rail .topbar-label { display: block; }
html.w-rail .menu { display: none; }
.menu { position: relative; }
.menu-list { position: absolute; z-index: 4; top: calc(100% + 4px); left: 0; width: min(320px, 90vw); max-height: 60vh; overflow-y: auto; padding: 6px; background: var(--popover); color: var(--popover-fg); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 8px 24px rgb(0 0 0 / .18); }
.menu-list[hidden] { display: none; }
.progress-wrap { flex: 1 1 240px; min-width: 160px; }
/* Without the rail the controls take the first line and progress gets a full line under them. */
html:not(.w-rail) .progress-wrap { order: 1; flex-basis: 100%; }
html:not(.w-rail) { scroll-padding-top: 112px; }
.progress { min-width: 48px; }
.progress-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.progress { flex: 1; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--fg) 12%, transparent); overflow: hidden; }
.progress-fill { display: block; height: 100%; background: var(--accent); }
.stop, .wrapup { display: flex; flex-direction: column; gap: 16px; padding: 24px 24px 0; }
.stop-headline { font-size: 19px; line-height: 1.35; }
h2.stop-headline { max-width: 72ch; }
.explain { display: flex; flex-direction: column; gap: 10px; font-size: 14.5px; }
/* A skim stop's files that don't follow its example. */
.differences { padding: 8px 12px; border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); border-radius: 0 6px 6px 0; }
.stop-lead { font-size: 16px; line-height: 1.5; margin: 0; }
.check-q { padding: 8px 12px; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 0 6px 6px 0; }
.stop .diff-view.card { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.wrapup h2 { font-size: 19px; }
/* No bullets: each line starts "Stop n:", and a bullet would sit on a wrapped button's last line. */
/* The wrap-up: the review in the wide column, what backs it up beside it (under it when narrow). */
.wrap-layout, .wrap-side, .wrap-main { display: flex; flex-direction: column; gap: 22px; }
.wrap-side, .wrap-main { min-width: 0; }
/* The wrap-up's comments, listed as GitHub lists them: where, then what. */
.review-comments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.rc { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); }
.rc.stale { border-color: var(--danger); }
.rc-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 6px 6px 10px; }
.rc-where { display: flex; align-items: baseline; gap: 6px; flex: 1; min-width: 0; overflow: hidden; padding: 2px 0; border: 0; background: none; color: inherit; font: 12px var(--mono); text-align: left; white-space: nowrap; }
button.rc-where { cursor: pointer; }
button.rc-where:hover .rc-file { text-decoration: underline; }
button.rc-where:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
.rc-chev { flex: none; width: 10px; color: var(--muted); }
.rc-chev::before { content: "▸"; }
.rc-where[aria-expanded="true"] .rc-chev::before { content: "▾"; }
.rc-dir { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.rc-file { flex: none; font-weight: 600; }
.rc-line { flex: none; color: var(--muted); font: 11.5px var(--sans); }
.rc-head .tag { flex: none; align-self: center; }
.tag.posted { border-color: var(--add); color: var(--add); }
.rc-more-wrap { position: relative; flex: none; }
.rc-more { width: 26px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--muted); font: 600 15px/24px var(--sans); cursor: pointer; }
.rc-more:hover, .rc-more[aria-expanded="true"] { background: var(--hover); color: var(--fg); }
.rc-more:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.rc-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 5; display: flex; flex-direction: column; min-width: 160px; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--popover, var(--card)); box-shadow: 0 8px 24px rgb(0 0 0 / .28); }
.rc-menu[hidden] { display: none; }
.rc-menu-item { padding: 6px 10px; border: 0; border-radius: 4px; background: none; color: inherit; font: 13px var(--sans); text-align: left; cursor: pointer; }
.rc-menu-item:hover, .rc-menu-item:focus-visible { background: var(--hover); outline: none; }
.rc-snippet { margin: 0 10px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); overflow: hidden; }
.rc-snippet[hidden] { display: none; }
.rc-snippet > p { margin: 0; padding: 8px 12px; }
.rc-snippet .dv-scroll { max-height: 260px; }
.rc-snippet .dv-rows { padding: 4px 0; }
.rc-text { margin: 0 10px 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: color-mix(in srgb, var(--fg) 3%, var(--bg)); }
.rc-text.editing { padding: 0; border: 0; background: none; }
.rc-text.editing .composer { max-width: none; }
.rc-body { overflow-wrap: anywhere; }
.rc-body > :first-child { margin-top: 0; }
.rc-body > :last-child { margin-bottom: 0; }
.rc.stale > .field-error, .rc.stale > .row { margin: 0 12px 10px; }
.skip-why { margin: 0; gap: 4px 12px; }
.handled { margin: 0; color: var(--add); font-weight: 500; }
/* The wrap-up's findings: the decision first, the comment folded under it. */
.suggestion.compact { background: none; border-left: 0; padding: 0; margin-top: 6px; gap: 4px; }
.suggestion-fold summary { cursor: pointer; color: var(--muted); width: fit-content; }
.suggestion-fold summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
.suggestion-fold p { margin: 6px 0 0; padding: 8px 12px; border-left: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 0 6px 6px 0; }
html.w-cols .wrap-layout:not(.solo) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 380px); gap: 40px; align-items: start; }
.view-heading:focus { outline: none; }
.view-heading:focus-visible { outline: 2px solid var(--ring); outline-offset: 4px; }
html.has-bar { scroll-padding-bottom: calc(var(--bar-h, 90px) + 16px); }
/* Sticky top bar: focus scrolled into view lands below it. */
html.w-rail { scroll-padding-top: 64px; }
/* z-index too: in the wrap-up's grid the card is a grid item, and grid items take z-index even when
   static, so the bar's 10 would lift it over the sticky top bar's step menu. */
.review-bar.inline { position: static; z-index: auto; max-height: none; overflow: visible; box-shadow: none; border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }
.review-bar.inline h2 { font-size: 15px; }
.review-bar.inline h3.eyebrow { margin: 0; }
.also { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px dashed var(--line); border-radius: 6px; }
.also-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.also-list li { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; justify-content: space-between; }
.dl.gap-row { --row: var(--card); }
.gap { display: block; width: 100%; min-height: 28px; padding: 0 12px 0 calc(2 * var(--ln, 4ch) + 48px); border: 0; border-block: 1px dashed var(--line); background: var(--card); color: var(--accent); font: 12px var(--sans); text-align: left; cursor: pointer; position: sticky; left: 0; }
.gap:hover { text-decoration: underline; }
.gap:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }

/* The diff */
.diff-view { display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
.dv-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 8px 16px 8px 10px; border-bottom: 1px solid var(--line); background: var(--card); color: var(--card-fg); }
.diff-view.collapsed .dv-head { border-bottom: 0; }
.dv-title { flex: 1 1 260px; min-width: 0; }
.dv-name { gap: 4px 12px; }
.dv-name.row { flex-wrap: nowrap; }
.dv-name > :not(.dv-path) { flex: none; }
.dv-path { flex: 0 1 auto; margin: 0; min-width: 0; overflow: hidden; font: 600 13px/1.4 var(--mono); }
/* The path is the open/close toggle; the chevron says which. */
.dv-toggle { display: inline-flex; gap: 6px; align-items: flex-start; min-height: 28px; padding: 3px 6px 3px 2px; border: 0; border-radius: 4px; background: none; color: inherit; font: inherit; text-align: left; white-space: nowrap; max-width: 100%; min-width: 0; cursor: pointer; }
.dv-toggle:hover { background: var(--hover); color: var(--hover-fg); }
.dv-toggle:hover .dv-path-text { text-decoration: underline; text-underline-offset: 3px; }
.dv-toggle .chev { flex: none; width: 16px; text-align: center; color: var(--muted); }
.dv-toggle[aria-expanded="true"] .chev::before { content: "▾"; }
.dv-toggle[aria-expanded="false"] .chev::before { content: "▸"; }
.dv-scroll[hidden] { display: none; }
/* A file in a list: no card header; actions only once it is open; the open diff in a box. */
.diff-view.listed .dv-head { background: none; color: var(--fg); border: 0; padding: 0; }
.diff-view.listed .dv-path { font-weight: 500; font-size: 12.5px; }
.diff-view.listed .dv-toggle { color: var(--accent); }
.diff-view.listed .dv-title > :not(.dv-name) { padding-left: 24px; }
.diff-view.listed.collapsed .dv-actions { display: none; }
.diff-view.listed .dv-scroll { margin-top: 8px; max-height: 70vh; border: 1px solid var(--line); border-radius: var(--radius); }
.dv-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); }
.dv-meta:empty { display: none; }
.dv-actions .btn.sm { min-width: 28px; }
.dv-scroll { position: relative; flex: 1; min-height: 0; overflow: auto; container-type: inline-size; }
.dv-scroll:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.dv-file { position: sticky; left: 0; width: 100cqw; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 0; }
.dv-file:empty { display: none; }
.dv-file:last-child:not(:empty) { padding-bottom: 16px; }
.dv-notice { color: var(--muted); padding: 8px 12px; border: 1px dashed var(--line); border-radius: 6px; }
.dv-rows { width: max-content; min-width: 100%; padding: 8px 0; font: 12px/24px var(--mono); font-family: var(--code-font, var(--mono)); font-size: var(--code-size, 12px); font-weight: var(--code-weight, 400); line-height: var(--code-lh, 24px); font-variant-ligatures: var(--code-liga, normal); tab-size: 4; }
.dl { display: flex; background: var(--row, var(--bg)); }
.dl.k-add { --row: color-mix(in srgb, var(--add) 13%, var(--bg)); }
.dl.k-del { --row: color-mix(in srgb, var(--danger) 12%, var(--bg)); }
.dl.hunk { --row: var(--card); color: var(--muted); }
.dl.eof { color: var(--muted); font-style: italic; }
.dl.target { --row: color-mix(in srgb, var(--accent) 20%, var(--bg)); }
/* The gutter stays put while long lines scroll sideways. */
.dl .gut { position: sticky; left: 0; z-index: 1; display: flex; flex: none; align-items: center; padding-left: 8px; background: var(--row, var(--bg)); }
.dl.target .gut { box-shadow: inset 3px 0 0 var(--accent); }
.dl.hunk .gut, .dl.eof .gut { width: calc(2 * var(--ln, 4ch) + 48px); align-self: stretch; }
.dl .ln { width: var(--ln, 4ch); padding-right: 6px; text-align: right; color: var(--muted); user-select: none; }
/* The comment button is a full 24×24 target; rows are 24px tall to fit it. */
.dl .plus, .dl .plus-space { width: 24px; flex: none; }
.dl .plus { height: 24px; padding: 0; border: 0; border-radius: 4px; background: var(--accent); color: var(--accent-fg); font: 600 15px/24px var(--sans); cursor: pointer; opacity: 0; }
.dl:hover .plus, .dl .plus:focus-visible, .dl.target .plus { opacity: 1; }
/* The "+" sits over the pending-comment marker, so hovering a commented line still offers "+". */
.dl .slot { position: relative; display: flex; width: 24px; height: 24px; flex: none; }
.dl .slot .plus { position: relative; z-index: 1; }
.dl.target.has-comment:not(:hover) .plus:not(:focus-visible) { opacity: 0; }
.dl .c-mark { position: absolute; left: 4px; top: 4px; width: 16px; height: 16px; fill: var(--accent); }
/* Lines a range comment (or the open composer) covers: a tint and a bar at the gutter's edge. */
.dl.in-range { background-image: linear-gradient(color-mix(in srgb, var(--accent) 10%, transparent), color-mix(in srgb, var(--accent) 10%, transparent)); }
.dl.in-range .gut { background-image: linear-gradient(color-mix(in srgb, var(--accent) 10%, transparent), color-mix(in srgb, var(--accent) 10%, transparent)); box-shadow: inset 3px 0 0 var(--accent); }
.dl .sign { width: 16px; text-align: center; user-select: none; }
.dl.k-add .sign { color: var(--add); font-weight: 700; }
.dl.k-del .sign { color: var(--danger); font-weight: 700; }
.dl .code { white-space: pre; padding-right: 24px; }
/* Changed words: a stronger tint of the row's own colour, plus an underline so it isn't colour alone. */
.dl .imp { cursor: pointer; }
.dl .imp:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
.dl.k-add .word { background: color-mix(in srgb, var(--add) 38%, transparent); border-radius: 2px; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--add) 70%, transparent); text-underline-offset: 3px; }
.dl.k-del .word { background: color-mix(in srgb, var(--danger) 36%, transparent); border-radius: 2px; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--danger) 70%, transparent); }
.dl.hunk .code, .dl.eof .code { padding-left: 4px; }
.dl.expander { --row: color-mix(in srgb, var(--accent) 8%, var(--card)); }
.dl.expander .gut { flex-direction: column; align-items: stretch; justify-content: center; padding-left: 0; }
.dl.expander .code { align-self: center; }
.dl .expand { display: flex; align-items: center; justify-content: center; flex: 1; min-height: 24px; padding: 0; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.dl.expander.two .expand { min-height: 16px; }
.dl .expand svg { width: 16px; height: 16px; fill: currentColor; }
.dl .expand:hover, .dl .expand:focus-visible { background: var(--accent); color: var(--accent-fg); }
.annot { position: sticky; left: 0; width: 100cqw; display: flex; flex-direction: column; gap: 8px; padding: 8px 16px 10px calc(2 * var(--ln, 4ch) + 48px); background: var(--bg); border-block: 1px solid var(--line); font: 13px/1.5 var(--sans); }
/* Findings, pending comments and composers under a line share one width and one left edge. */
.annot > * { max-width: 760px; box-sizing: border-box; }
/* One card shape for everything under a line: a border, one radius, and a bar down the left edge
   that says whose it is (a finding's severity, or the accent for your own comment). */
.finding-card, .draft-card { border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--card-fg); box-shadow: inset 3px 0 0 var(--bar, var(--line)); }
.finding-card { padding: 6px 12px 6px 14px; }
.finding-card > summary { display: flex; align-items: baseline; gap: 8px; min-height: 24px; cursor: pointer; list-style: none; font-weight: 500; }
.finding-headline { flex: 1; min-width: 0; }
.finding-card > summary::-webkit-details-marker { display: none; }
.finding-card > summary::before { content: "▸"; color: var(--muted); }
.finding-card[open] > summary::before { content: "▾"; }
.finding-card[open] > summary { margin-bottom: 6px; }
.finding-card > :not(summary) { margin-left: 16px; }
.finding-state { margin-left: auto; font-weight: 400; color: var(--muted); white-space: nowrap; }
.fold-icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; display: block; margin: auto; }
.dv-full[aria-pressed="true"] { border-color: var(--accent); }
.finding-card.blocker, .finding-card.major { --bar: var(--danger); }
.finding-card.minor { --bar: var(--warn); }
.finding-card .suggestion { background: none; }
/* A pending comment, in place under its line or file header. */
.draft-card { --bar: var(--accent); display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 10px 14px; }
.draft-card .tag { align-self: center; }
.draft-card .btn.ghost { color: var(--muted); }
.draft-card .btn.ghost:hover, .draft-card .btn.ghost:focus-visible { color: var(--fg); }
.draft-card .btn.danger:hover, .draft-card .btn.danger:focus-visible { color: var(--danger); border-color: var(--danger); }
/* Focus moved here by the page (after Save, or the bar's ‹ ›) shows a ring only for keyboard use. */
.draft-card:focus { outline: none; }
.draft-card:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.tag.pending { border-color: var(--accent); color: var(--accent); align-self: center; }
.posted-card { display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 10px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--card-fg); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--add) 60%, transparent); }
.posted-card .tag { align-self: center; }
.posted-card .btn.ghost { color: var(--muted); }
.posted-card .btn.ghost:hover, .posted-card .btn.ghost:focus-visible { color: var(--fg); }
.pending-meta { color: var(--accent); font-weight: 500; }
.pending-meta:empty { display: none; }
.draft-body { white-space: pre-wrap; overflow-wrap: anywhere; }
/* A very narrow tab (html.w-narrow is set from the tab's own width). */
html.w-narrow .annot { padding-left: 12px; }
html.w-narrow .page { padding: 18px 16px calc(var(--bar-h, 0px) + 32px); }
html.w-narrow .stop, html.w-narrow .wrapup { padding: 18px 16px 0; }
html.w-narrow .topbar { padding: 8px 16px; }
html.w-narrow .rows > li.claim, html.w-narrow .point { grid-template-columns: 1fr; }
html.w-narrow .finding-row { grid-template-columns: minmax(0, 1fr) auto; }
html.w-narrow .finding-row > .stack-xs { grid-column: 1 / -1; grid-row: 2; }
html.w-narrow .review-bar { padding-left: 16px; }
/* One file's path on one line: the folders shorten first, the file name stays whole. */
.dv-path-text { display: flex; min-width: 0; overflow: hidden; }
.dv-dir { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-weight: 400; }
.dv-base { flex: none; }
.dv-actions { flex: none; align-items: center; align-self: flex-start; }
.btn.dv-viewed { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.btn.dv-viewed:has(.cbox:checked) { color: var(--fg); border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
.btn.dv-viewed:has(.cbox:disabled) { cursor: default; }
/* Checkboxes in the rail and the file headers: the native input, drawn small and flat. */
.cbox { appearance: none; -webkit-appearance: none; display: inline-grid; place-content: center; width: 14px; height: 14px; margin: 0; flex: none; border: 1px solid color-mix(in srgb, var(--fg) 30%, transparent); border-radius: 4px; background: var(--bg); transition: background-color 120ms, border-color 120ms; }
.cbox { cursor: pointer; }
.cbox::before { content: ""; width: 10px; height: 10px; background: var(--accent-fg); -webkit-mask: var(--check) center / contain no-repeat; mask: var(--check) center / contain no-repeat; transform: scale(0); transition: transform 120ms; }
.cbox:checked, .cbox:indeterminate { background: var(--accent); border-color: var(--accent); }
.cbox:checked::before { transform: scale(1); }
.cbox:indeterminate::before { -webkit-mask: none; mask: none; width: 8px; height: 2px; border-radius: 1px; transform: scale(1); }
.cbox:hover:not(:disabled) { border-color: var(--accent); }
.cbox:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.cbox:disabled { opacity: .45; cursor: default; }
/* The rail: Groups (each with its files and a Reviewed box) or Files (a folder tree). */
.rail-body { display: flex; flex-direction: column; gap: 6px; min-height: 100%; }
.rail-mode { position: sticky; bottom: 0; display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: auto; padding: 10px 4px 12px; border-top: 1px solid var(--line); background: var(--bg); }
.rail-mode-label { color: var(--muted); font: 11px var(--sans); }
.rail-mode .seg { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 6px; }
.rail-mode .seg button { height: 22px; padding: 0 10px; border: 0; border-radius: 4px; background: none; color: var(--muted); font: 500 11px var(--sans); cursor: pointer; }
.rail-mode .seg button:hover { color: var(--fg); }
.rail-mode .seg button[aria-pressed="true"] { background: var(--hover); color: var(--fg); }
.rail-mode .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rail-groups { display: flex; flex-direction: column; gap: 4px; }
.rg-head .step-link[aria-current="step"] { background: none; }
.rg-head .step-link[aria-current="step"]:hover { background: var(--hover); }
.rg { border-top: 1px solid var(--line); padding: 4px 0; }
.rg:last-child { border-bottom: 1px solid var(--line); }
.rg-head { display: flex; align-items: center; gap: 2px; }
.rg-head .step-link { flex: 1; min-width: 0; }
.rg-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rg-chev { width: 20px; height: 24px; flex: none; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--muted); cursor: pointer; }
.rg-chev:hover { background: var(--hover); }
.rg-chev[aria-expanded="true"]::before { content: "▾"; }
.rg-chev[aria-expanded="false"]::before { content: "▸"; }
.rg-reviewed { display: flex; align-items: center; padding: 0 6px; cursor: pointer; }
.rg-files, .ft { list-style: none; margin: 0; padding: 0; }
.rg-files { display: flex; flex-direction: column; gap: 2px; padding: 8px 0 10px 22px; }
.ft { display: flex; flex-direction: column; gap: 2px; }
.rg-files[hidden], .ft[hidden] { display: none; }
/* Tree rows: a 16px chevron column, then the box, then the name, so boxes line up per level. */
.ft .ft { padding-left: 14px; }
.ft-row { display: flex; gap: 8px; align-items: center; min-height: 27px; padding: 0 6px 0 2px; border-radius: 4px; }
.ft-row:hover { background: var(--hover); }
.ft-chev { width: 16px; height: 20px; flex: none; padding: 0; border: 0; background: none; color: var(--muted); font: 10px var(--sans); cursor: pointer; }
.ft-chev[data-open="true"]::before { content: "▾"; }
.ft-chev[data-open="false"]::before { content: "▸"; }
.cbox-space { width: 14px; flex: none; }
.ft-dir { flex: 1; min-width: 0; align-self: stretch; padding: 0; border: 0; background: none; color: var(--muted); font: 12px var(--mono); text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ft-dir:focus-visible, .rf-go:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; border-radius: 3px; }
.rf { display: flex; gap: 8px; align-items: center; min-height: 27px; padding: 0 6px 0 4px; border-radius: 4px; }
.ft > li > .rf { padding-left: 26px; }
.rf:hover { background: var(--hover); }
.rf-go { flex: 1; min-width: 0; align-self: stretch; display: flex; gap: 8px; align-items: center; padding: 0; border: 0; background: none; color: inherit; font: 12px var(--mono); text-align: left; cursor: pointer; }
.rf.now { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 70%, transparent); }
.rf-name { flex: 1; display: flex; min-width: 0; overflow: hidden; white-space: nowrap; }
.rf-stem { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.rf-ext { flex: none; }
.rf.viewed .rf-name { color: var(--muted); }
.rf-count { flex: none; min-width: 64px; font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.rf-count .add { color: var(--add); }
.rf-count .del { color: var(--danger); }
.rf .tag { height: 16px; font-size: 10px; }
/* A group's files, stacked as diff cards; the agent's focus lines carry an accent bar. */
.group-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.group-file .diff-view.card { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.dl.focus-line .gut { box-shadow: inset 3px 0 0 var(--accent); }
.test-hint { margin: 0; }
.diff-view:not(.collapsed) .test-hint { display: none; }
.code-theme-btn { position: fixed; right: 16px; bottom: calc(var(--bar-h, 0px) + 12px); z-index: 4; }
${CODE_THEMES.map(
  ({ id }) =>
    `html[data-code-theme="${id}"] .dl .code .tok { color: var(--tc-${id}, inherit); font-style: var(--ti-${id}, normal); font-weight: var(--tb-${id}, inherit); }`,
).join("\n")}
`;
