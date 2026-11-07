# Review surface header fix: before/after evidence

Task 3f8d291a (2026-11-07). Robert could not review the status report layouts
because the summary block pinned at the top of the review page covered the
design. This folder holds before/after screenshots of that exact document
(design package `bdc3746b`, "Standard status report layout: before/after renders
for Joey and Meeple Magnate") and the measurements behind them.

## What changed

- Only a slim bar stays pinned on desktop: breadcrumb, title, actions and one
  line of status chips. The human brief left the sticky header.
- The brief now opens the stage column, folded to "What I need from you" with a
  "Show details" control, and scrolls away with the page. It is never pinned.
- The rails stick 1.25rem below the slim bar's measured height, and the rail
  columns now reach over the footer, so at the end of the page the rails no
  longer ride up under the bar (they did by 69px at 100% before).
- Phone and tablet: every tap target in the header, the brief toggle, the bottom
  bar, the drawer close buttons, Present this revision (display shell only) and
  Approve / Request changes is at least 44px tall. The drawers end at least 4.5rem above the bottom of the screen, so the
  bottom-left issue pill no longer sits on Finish review.

## Measurements (scripts/review-header-browser-check.mjs)

Window 1470x847 CSS px (Robert's screenshot) for desktop; 768x1024 and 375x812
for tablet and phone. "Pinned" is the height of what stays fixed at the top
after scrolling.

| Config | Pinned before | Pinned after | Brief pinned before / after | Rails vs bar after | Header and drawer taps under 44px before / after (round 0 probe; see QA round 1 below for every control) |
| --- | --- | --- | --- | --- | --- |
| Desktop 100% | 379px (45%) | 102px (12%) | yes / no | 20px below | n/a |
| Desktop 125% | 495px (58%) | 126px (15%) | yes / no | 24px below | n/a |
| Desktop 150% | 644px (76%) | 201px (24%) | yes / no | 30px below | n/a |
| Tablet 768px | 0 (header scrolls) | 0 | no / no | rails hidden | 17 / 0 |
| Phone 375px | 0 (header scrolls) | 0 | no / no | rails hidden | 15 / 0 |

No horizontal overflow in any configuration, before or after. Approve and
Request changes are uncovered by any floating control in every configuration,
and after the change Finish review is uncovered at the end of the phone and
tablet drawer.

Every live media type was checked at desktop 125%, 768px and 375px
(`media-types/`, regenerated in QA round 1): markdown, json, text, image, code,
pdf and html all report the brief unpinned, rails below the bar and no tap
target under 44px (see the QA round 1 table below for the one content overflow).
No video, audio or SVG document is registered, so those were covered by the
shared page shell (the header, brief and rails do not branch on media type) and
the component tests.

## QA round 1: every review control is a 44px target

QA found that the first round's probe only measured the header, so its empty
tap-target list was misleading: Finish review was 38px tall, Add a note 34px,
History 17px, and the image toolbar's Zoom out and Full screen 21x21px.

The reproduction (`before/qa-round1-report.json` and the `before/qa-round1-*`
shots) measured every visible control in both dimensions across the page, the
design tabs, the lightbox, the navigator, the review drawer, History, both
decision confirmations, the finish panel and the composer. It found 77
controls under 44px at 768px and 78 at 375px, out of 295.

What changed:

- `dashboard/src/lib/review-tap-targets.ts` holds one rule, applied to the
  review page root and to the full-screen lightbox (which is portaled outside
  it): below the large breakpoint every button, link, select, summary, tab and
  text or number input is at least 44px tall and 44px wide. The width floor is
  `!important` because `globals.css` resets `min-width` on flex children below
  768px, which otherwise beats it at 375px.
- Named controls carry their own classes too: Add a note, Finish review,
  History, the direction choices, the image toolbar, the design tabs,
  appearance switch, direction chips and compare, the drawer close buttons and
  the requirements checkboxes (the label is the target).
- Pins on images and prototypes and comment markers on the video timeline keep
  their visual size and take taps through an invisible 44px square. Video
  markers hang below a 44px seek bar instead of over it, the PDF page-marker
  row wraps, and markdown block comment buttons get a block tall enough that
  neighbouring buttons do not overlap.

After the fix (`after/after-report.json`):

| Config | Controls measured | Under 44px (either dimension) | States walked | Overlapping targets | Overflow |
| --- | --- | --- | --- | --- | --- |
| Tablet 768px | 294 | 0 | 14 | 0 | none |
| Phone 375px | 294 | 0 | 14 | 0 | none |

Desktop is unchanged: 102px, 126px and 201px pinned at 100%, 125% and 150%,
brief not pinned, rails 20, 24 and 30px below the bar.

Every live media type, same probe (`media-types/`), at 768px / 375px:

| Media type | Controls measured | Under 44px | States walked | Overlapping | Exempt (reason) | Overflow |
| --- | --- | --- | --- | --- | --- | --- |
| Markdown | 62 / 110 | 0 / 0 | 9 | 0 | none | 375px: document's inline-code token (caveat below) |
| JSON | 37 / 37 | 0 / 0 | 7 | 0 | 78 line-gutter numbers | none |
| Text | 37 / 37 | 0 / 0 | 7 | 0 | 7 line-gutter numbers | none |
| Image | 45 / 45 | 0 / 0 | 8 | 0 | none | none |
| Code | 37 / 37 | 0 / 0 | 7 | 0 | 46 line-gutter numbers | none |
| PDF | 40 / 40 | 0 / 0 | 7 | 0 | 1 link in running text | none |
| HTML | 38 / 38 | 0 / 0 | 7 | 0 | none | none |

At desktop 125% every media type pins 126px, the brief is not pinned and the
rails sit 24px below the bar. No video, audio or SVG document is registered
live; the video player's 44px seek bar, marker strip and controls are covered
by `dashboard/src/components/__tests__/review-tap-targets.test.mjs` and were
measured in headless Chrome from a static render with the live stylesheet.

Left out on purpose, and reported by the probe as exempt rather than hidden:

- The line-number gutter in text and code files (`data-line-gutter`). Each
  number is the height of its line of code; 44px rows doubled the length of a
  code file. WCAG 2.5.8 exempts targets whose size is set by the line height of
  the text around them.
- Links inside running text (also a WCAG 2.5.8 exception).

Caveat: the markdown document used for the media check (`8cbcbe42`) contains a
long inline-code JSON token that runs to 472px on a 375px screen. It does so
with or without this change (it is document content, not the page layout).

## Files

- `before/` and `after/`: `<config>-top.png` (page load), `<config>-scrolled.png`
  (after scrolling 700px or to the end), `<config>-drawer.png` (phone and tablet
  review drawer), `after/<config>-drawer-end.png` (drawer scrolled to its end),
  and the JSON reports.
- `before/qa-round1-<config>-<state>.png` and `before/qa-round1-report.json`:
  the QA round 1 reproduction before the tap-target fix (scrolled page, drawer,
  lightbox, navigator, finish panel and composer).
- `after/after-<config>-<state>.png` for the same states after the fix, plus
  `confirm-approve` and `confirm-request_changes` (the expanded decision
  confirmations).
- `media-types/`: one report per live media type at desktop 125%, 768px and
  375px.
- `review-surface-header.design.json`: the design package Nexus shows.
