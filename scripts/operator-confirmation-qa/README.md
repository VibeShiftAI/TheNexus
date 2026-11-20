# Operator confirmation live check

Task `5e513530`. These files prove Robert's Option A on the Mac: a decision
made through the local operator session records nothing until Robert answers
a native macOS dialog that names the exact action. The contract is in
`docs/contracts/local-operator-session.md` (section "Per-action
confirmation").

| File | Role |
|---|---|
| `live-check.cjs` | Starts an isolated Nexus API on `127.0.0.1:4299`, runs the steps, checks every result and writes the evidence JSON. |
| `check-page.html` | The page served at `/check`. Its script plays the part of a script an executor added to a dashboard page. |
| `dialog-probe.swift` | Looks up the dialog window in the window server list. When the screen is unlocked it reads the dialog, or presses a button, through Accessibility. |
| `webview-host.swift` | A WebKit webview host that sets up the session the way the desktop app does (`desktop/src-tauri/src/local_operator.rs`). |

## Run

```sh
node scripts/operator-confirmation-qa/live-check.cjs --client chrome
node scripts/operator-confirmation-qa/live-check.cjs --client webview
node scripts/operator-confirmation-qa/live-check.cjs --client chrome --attended
```

- **Chrome run.** Opens one tab in Robert's running Google Chrome (`open -a "Google Chrome"`). The real kernel peer check then has to recognize that Chrome before the session opens.
- **Webview run.** Starts `webview-host`. The harness pins that process in place of the desktop app's code-signature pin, because the installed app only talks to the live `:4000`.
- **Attended run.** Waits up to 45 seconds per dialog. The page tells Robert which button to click, and his clicks replace the harness answers.
- **Output.** Evidence goes to `docs/reviews/2026-11-20-operator-confirmation/live-<client>[-attended].json`. The exit code is 0 when every check passes, 1 when a check fails and 2 when the run stops early.
- **Requirements.** macOS, `/usr/bin/swiftc` (the Swift files are compiled into `$TMPDIR/nexus-opconf-bin`) and a free port 4299 (`--port` changes it).

## Isolation

- **Data.** A temporary SQLite database and temporary files hold synthetic documents. Both are removed after the run.
- **Keys.** The harness generates random throwaway keys. Before any server module loads, it clears every `NEXUS_`, `PRAXIS_`, `CF_` and `CLOUDFLARE` environment variable, so the real operator and document keys are never read.
- **Praxis.** An in-process stand-in serves Praxis Mail. It checks the body-bound relay signature and the draft version, and it sends nothing.
- **Live services.** The run never contacts the live `:3000` or `:4000`. The Chrome session cookie is host-only for `127.0.0.1`, path `/api`, and the run revokes it at the end.

## How dialogs are answered

- **Unanswered.** A dialog the step leaves alone times out (8 seconds by default).
- **Unlocked screen.** A dialog the step answers is pressed through Accessibility.
  - `dialog-probe` only reads or presses dialogs from an osascript process started by the same parent as the probe, so it cannot reach the live API's dialogs.
  - That such a press can work at all is a documented limit: macOS lets a same-user process that holds the Accessibility permission press buttons in other apps' windows, so such a process could answer the dialog while the screen is unlocked.
- **Locked console.** Behind the lock screen the harness cannot reach the dialog: on 2026-11-20 an Accessibility read found none of its contents, and a key event posted to the dialog process did not answer it. The harness therefore closes the dialog and hands the broker the planned answer. Each dialog record states this as `answer_source: "stand-in (console locked)"`. (Records from those runs say "no process can press"; that overstates what was tested, and the harness now says "the harness cannot press".)
- **Recorded runs.** Both recorded runs of 2026-11-20 had the console locked throughout, so the unlocked Accessibility press above has not been exercised live.
- **Attended run.** Robert clicks every answer himself (`answer_source: "Robert"`).
- **Webview while locked.** The host turns off WebKit's window-occlusion detection, so the page keeps running behind the lock screen as it would in a visible window. It also copies the page's own log lines into `host_log`.
