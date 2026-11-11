# Pixel motion for the console

Bring the seven motions from the approved sample page into the console, built on the logo adopted in #54.
Baseline: `main` at `fcb6f88`. OMP is 18.18.8, the latest published; no upgrade needed.

## Motion rule

Everything moves on the pixel grid, in steps. One timing token (`--step: 60ms`), `steps(n, end)` easing only,
transform and opacity only. No blur, no easing curves. Reduced motion turns all of it off; the global rule at
`app/app/globals.css:1673` already does this, and each PR confirms it still covers the new SVG rects.

## What exists today (surveyed)

- Brand: `BrandMark` inline in `app/shell/console-sidebar.tsx`, two static paths.
- Nav active state: a 2px left border on `.sidebar nav a.active` (`globals.css:238`), 140ms eased transition.
- Spinners: lucide `LoaderCircle` in 3 places (workspace empty state, create form x2); `RefreshCw` with
  `animate-spin` on 8 refresh buttons.
- Live status: `.codex-status-pill[data-tone=auto|manual|standby]` with a round `.codex-status-dot`
  (`features/live/shiori-cockpit.tsx:2599`), phase label beside it.
- Budget: `.shiori-budget-bar` with a continuous width fill (`shiori-cockpit.tsx:3075`).
- Round status dots elsewhere: `.status-dot` (shell), `.triad-status-dot` (capabilities).
- No general toast system. The only toast is `.codex-jump-toast` on Live.
- No shared keyframes in the console CSS; `tw-animate-css` is installed.

## Phases (one PR each)

### 1 · Foundation (done in this PR)
- `app/components/ui/pixel-mark.tsx`: `PixelMark` renders the ring as one outline at rest and as 13 separate
  cells while loading or assembling (separate cells show faint seams at small sizes), plus 5 hollow-L cells
  and the loose pixel. Props: `size`, `state` (`idle | reasoning | recording | passed | failed | waiting`),
  `loading` (chase), `filled` (hollow L lit), `assemble`.
- `app/app/pixel-motion.css`: `--step` token and the keyframes (drop, land, chase, pulse, blink, pop, shake, hop).
- Replace `BrandMark` with `PixelMark`; add the hover hop.
- Tests: server-render `PixelMark` for each state and assert cell count and state attributes.
- Docs: add a Motion subsection under Brand Mark in `docs/en/reference/dashboard-ui.md` and the `zh` mirror.

### 2 · Shell
- Sidebar cursor: replace the left border with an 8px pixel that steps to the active item. Nav has two
  sections and collapses to a menu at 680px, so position comes from the active link's measured offset, not
  an index. Below 680px it falls back to the static pixel.
- Chase loader: swap the 3 `LoaderCircle` uses for `PixelMark loading`. Leave the `RefreshCw` buttons alone;
  a rotating refresh arrow already says what the button does.
- Assemble: play once per browser session on first console load.

### 3 · Live
- Status pixel: `PixelMark` replaces `.codex-status-dot`. State is derived from what the pill already has
  (`data-tone`, host online, phase); no new backend fields.
- Pixel meter: `.shiori-budget-bar` becomes 24 blocks with the leading block in orange. Keep
  `role="progressbar"` and its aria values unchanged.
- Control handoff: when the pill's tone flips between `auto` and `manual`, the hollow L fills or drains in blue.
- `shiori-cockpit.tsx` is 3,100 lines and changed in #50 and #53; keep edits to the three call sites and
  rebase immediately before opening the PR.

### 4 · Capabilities (optional)
- Eval run button carries the chase loader; `.capability-eval-status` shows the passed/failed pixel.
- Square the round `.triad-status-dot` and `.status-dot` to match.

## Verification for every PR
- `bun run typecheck` and `bun run test` in `app`.
- Open the console in a browser and watch each motion; repeat with reduced motion on.
- Phase 3: check against a live run that the stream and feed stay smooth while the status pixel animates.

## Decisions (left to the implementer, 2026-11-11)
1. Result toast: no new toast system; results show in the existing inline status.
2. Assemble frequency: once per browser session.
3. Phase 4 scope: square every status dot in the console.
4. Tab icon as a status light (pixel changes colour with run state): not planned here; needs its own design.

## Close-out
Delete this file and its line in `PLANS.md` in the last PR.
