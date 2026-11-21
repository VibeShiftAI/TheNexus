# Operator confirmation live check

Task `5e513530`. These files prove Robert's Option A on the Mac: a decision
made through the local operator session records nothing until Robert answers
a native macOS dialog that names the exact action. The contract is in
`docs/contracts/local-operator-session.md` (section "Per-action
confirmation").

| File | Role |
|---|---|
| `live-check.cjs` | Starts an isolated Nexus API on `127.0.0.1:4299` with the real session store, peer check, decision routes, confirmation broker and osascript dialog, runs the steps, checks every result and writes the evidence JSON. |
| `check-page.html` | The page served at `/check`. Its script plays the part of a script an executor added to a dashboard page. It never answers a dialog; it can only stop waiting for one. |
| `dialog-probe.swift` | Looks only. `window` finds the dialog in the window server list, `watch` reports whether it is still on screen, `read` reads its text and buttons through Accessibility (unlocked screen only), `session` reports the console lock state. It has no mode that clicks, presses or types. |
| `webview-host.swift` | A WebKit webview host that sets up the session the way the desktop app does (`desktop/src-tauri/src/local_operator.rs`). It stands in for the app; it is not the app. |

## Run

```sh
node scripts/operator-confirmation-qa/live-check.cjs --client chrome
node scripts/operator-confirmation-qa/live-check.cjs --client webview
node scripts/operator-confirmation-qa/live-check.cjs --client chrome --attended
node scripts/operator-confirmation-qa/live-check.cjs --client webview --attended
```

- **Chrome.** Opens one tab in Robert's running Google Chrome (`open -a "Google Chrome"`). The real kernel peer check then has to recognize that Chrome before the session opens.
- **Webview.** Starts `webview-host`. The installed desktop app talks only to the live `:4000` and `:3000`, and the real peer check accepts only the signed app in `/Applications`, so the harness pins the host process it started in place of the app's code-signature check. Its runs are component evidence for the webview path, not runs of the desktop app.
- **Unattended (default).** Runs only the steps that need no answer: reads, refusals where nobody answers and the page gives up, the unavailable path, the busy path and the hold step. Nobody needs to be at the Mac, and nobody should click.
- **Attended (`--attended`).** The page shows a "Start the attended check" button and nothing is asked before Robert presses it. For each dialog the page names the button to click. The Chrome run asks for 8 clicks (Cancel four times, then Approve, Send, Send and Approve after changes, interleaved); the webview run asks for 2 (Cancel, then Approve).
- **Output.** `docs/reviews/2026-11-20-operator-confirmation/live-<client>-<attended|unattended>.json`; `--out <file.json>` writes elsewhere, which keeps an earlier run (the second attended Chrome run on 2026-11-20 wrote `live-chrome-attended-2.json`). The exit code is 0 when every check passes, 1 when a check fails and 2 when the run stops early.
- **Requirements.** macOS, `/usr/bin/swiftc` (the Swift files are compiled into `$TMPDIR/nexus-opconf-bin`) and a free port 4299 (`--port` changes it).

## How a dialog ends

The harness never answers a dialog. Each dialog record in the evidence says
which of these four endings it had, and its `outcome` is always what the
broker got back from osascript:

| Ending | When | Expected outcome |
|---|---|---|
| Robert clicks a button | `--attended` only | `confirmed` or `declined`, as osascript returned it. The check also requires a keyboard or mouse event after the dialog appeared: HID idle time at the answer (`ioreg`, `HIDIdleTime`) is shorter than the time the dialog was open. |
| The page gives up | Refusal steps, the busy step | `aborted`: the page aborts its request once the dialog is on screen, the response closes and the broker kills osascript. |
| The harness ends the dialog process | The kill step | `unavailable`: SIGKILL on osascript before any answer; nothing is recorded and there is no fallback. |
| Hold, then the page gives up | Unattended Chrome run only | `aborted`, after `dialog-probe watch` saw the unanswered dialog still on screen once it had been open longer than the previous version let a dialog live (120 s give-up plus 15 s process allowance, from 8cf041e9). |

## Guards

The harness has its own guards so a broken run stops instead of hanging
(`GUARDS` in `live-check.cjs`, copied into every report). None of them is
product behavior, and each can only fail a check or stop the run, never pass
one: helper commands (git, ioreg, ps, lsof, open) 30 s; the dialog window must
appear within 8 s of osascript starting and be gone within 2 s of its outcome;
an Accessibility read gets 3 s; the page must boot within 120 s and report its
end within 30 s. A dialog itself is never timed: a step waits for as long as
its dialog is open. The webview host waits for the bootstrap answer as long as
the desktop app does (12 s read timeout) and stops when the harness that
started it is gone.

## Isolation

- **Data.** A temporary SQLite database and temporary files hold synthetic documents. Both are removed after the run.
- **Keys.** The harness generates random throwaway keys. Before any server module loads, it clears every `NEXUS_`, `PRAXIS_`, `CF_` and `CLOUDFLARE` environment variable, so the real operator and document keys are never read.
- **Praxis.** An in-process stand-in serves Praxis Mail. It checks the body-bound relay signature and the draft version, and it sends nothing.
- **Live services.** The run never contacts the live `:3000` or `:4000`. The Chrome session cookie is host-only for `127.0.0.1`, path `/api`, and the run revokes it at the end.
- **Locked screen.** The window server list still answers behind the lock screen, so `window` and `watch` work there; Accessibility does not, so `read` runs only when the screen is unlocked. The webview host turns off WebKit's window-occlusion detection so the page keeps running behind the lock screen, and copies the page's own log lines into `host_log`.

## Earlier runs

`live-chrome.json` and `live-webview.json` (generated 2026-11-20 at 20:56Z
and 20:57Z, committed in `c3aebd10`) came from an earlier version of this
harness and of the broker. With the console locked that harness closed each
dialog it meant to answer and handed the broker a planned answer
(`answer_source: "stand-in (console locked)"`, 5 dialogs in Chrome and 1 in
the webview), letting that answer stand in for the process outcome, and its
unanswered dialogs ended on the broker's give-up time (set to 8 s for those
runs), which no longer exists. Those files are kept as component evidence for the server boundary
only. They are not evidence of a native answer, and the current harness has
no code path that answers.
