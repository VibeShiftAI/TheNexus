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

| Config | Pinned before | Pinned after | Brief pinned before / after | Rails vs bar after | Taps under 44px before / after |
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

Every live media type was checked at desktop 125% and phone 375px
(`media-types/`): markdown, json, text, image, code, pdf and html all report the
brief unpinned, rails below the bar, no overflow and no tap target under 44px.
No video, audio or SVG document is registered, so those were covered by the
shared page shell (the header, brief and rails do not branch on media type) and
the component tests.

## Files

- `before/` and `after/`: `<config>-top.png` (page load), `<config>-scrolled.png`
  (after scrolling 700px or to the end), `<config>-drawer.png` (phone and tablet
  review drawer), `after/<config>-drawer-end.png` (drawer scrolled to its end),
  and the JSON reports.
- `review-surface-header.design.json`: the design package Nexus shows.
