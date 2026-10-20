# Device protection and external displays across the Nexus apps: capability assessment

**Task:** 3f35e87a-dfd8-42c7-aa4a-40c0c712b55f (idea capture, exploration only)
**Prepared:** 2026-10-20
**Revised:** 2026-10-20 by task 6d6e2638-8fc1-46fa-8545-3ad4d5876dc0 ("Apply Robert's Windows and Android display decisions to the capability assessment"), applying all six comments of review submission badf9eeb-2a54-4927-8244-12344ca00687 (review 30680910-fc13-4ce6-ab89-318043fb3a80) on revision 37b232e2-4807-4628-97b9-204cc5aa17bc, and the operator ruling in inbox query ask-robert-e300a46f-5aba-4a2c-8065-bc9ea8f1f090.
**Status:** assessment only. Nothing here is implemented, dispatched or filed by this document. The implementation work already exists as prepared tasks (section 7); this revision links them and creates none. No device was accessed, no display was discovered or connected, and nothing was deployed.

**Confidence labels used below.** *Verified locally* means read from a file in this machine's repos (path:line given). *Sourced* means confirmed against a current official vendor page listed in section 10 during this research. *Platform knowledge* means established platform behavior stated from prior knowledge and not re-checked; it must be re-verified when its slice is implemented.

**Route status labels used below.** *Implemented*: code exists in the Windows shell or Android app today. *Platform-supported*: the vendor documents the method, but Nexus does not use it yet. *Unknown*: no current official source settles it, or it depends on hardware that has not been checked. *Requires additional component*: the method works only after Nexus adds something it does not have, such as a receiver app, a registration, a permission grant, a dependency upgrade or a pairing service.

## 0. Robert's decisions (2026-10-20)

### 0.1 The six review comments and where each is applied

| # | Anchor in revision 37b232e2 | Robert's comment (verbatim) | How this revision applies it |
|---|---|---|---|
| 1 | Lines 23-29, app inventory | "Focus only on the Windows travel shell and the android app. The other versions will not need this functionality because they dont leave the house, and I don't need it from the web version." | Scope is the Windows travel shell and the Android app only (section 1). The browser dashboard, the Mac app, the iPad Home Hub and a future iPhone are out of scope for displays; their prior research is kept in Appendix H. |
| 2 | Lines 125-133, connection methods | "ok, lets put our focus here, for Windows and Android. give me as many of these capabilities as possible" | Section 4 classifies every connection method for both apps against current official docs, and section 7 maps each feasible method to a prepared task. |
| 3 | Lines 151-154, the four views | "yes to all 4, this is what I'm talking about!" | All four views are approved and in scope (section 2). |
| 4 | Line 160, display authentication | "if we are just talking about the windows app and android apps, use my existing authentication." | Sender-rendered routes reuse the app's existing sign-in with no new credential. A separate TV or Cast receiver does not inherit that sign-in, so it uses only the temporary view-only pairing Robert approved (section 3). The earlier claim that a TV "cannot complete a Cloudflare Access login" is corrected there. |
| 5 | Line 164, recommended approach | "I want to be able to say "Praxis show me the displays you can see" OK, display this document review on X screen"" | Section 5 specifies the conversational discovery and selection workflow, owned by prepared task b5170694-aae7-49ec-aac0-c7fd63077b91. |
| 6 | Lines 172-176, questions | "1. Android 2. skip protection for now, focus on displays 3. n/a we are skipping protections 4. TV with chromecast, apple TV, or other smart TV browsers. don't worry about the mac or ipad 5. ipad is not in scope, it never leaves the house" | The questions are replaced by Robert's answers (section 8). Part A (protection) is deferred and kept unchanged in Appendix H2. The display targets are a TV with Chromecast, an Apple TV, or another smart-TV browser. |

### 0.2 Operator ruling recorded (inbox query ask-robert-e300a46f-5aba-4a2c-8065-bc9ea8f1f090, resolved 2026-10-20)

Robert's answer on the prepared Windows task: "Yes the read only is fine for now, we can expand later if needed. Use my android and my laptop, and you should be able to find "Living Room TV" on the same network as the Mac to test with."

What the ruling decides:

- **Temporary receiver pairing is approved.** A separate Chromecast or TV-browser receiver may be paired temporarily, from Robert's existing signed-in Windows or Android app, to the one selected read-only view only.
- **No separate account.** The receiver gets no account of its own. Stop and revoke happen from the controller, meaning the signed-in app that started the presentation.
- **No authority on the TV.** The receiver gets no full login and no general operator authority. Editing, approval and expanded receiver privileges stay out of scope.
- **Test devices:** Robert's Android phone, his Windows laptop, and the receiver named "Living Room TV", which is expected on the same network as the Mac.
- **Unverified hardware.** Models, OS versions, receiver protocol and reachability are all unverified. The friendly name "Living Room TV" is not evidence of Chromecast or AirPlay support, and this document infers neither.
- **Limits on Mac-side discovery.** Discovery run from the Mac may establish test inventory only. It never stands in for discovery originating on Windows or Android, and never stands in for native runtime proof.
- **Do not re-ask.** The pairing and device-selection questions are answered and are not asked again.

### 0.3 What this revision does not authorize

Recording Robert's approval of this assessment approves this assessment revision only. It does not approve any of the following:

- dispatching the implementation tasks;
- a new authentication architecture beyond the pairing Robert ruled on;
- spending (for example the Cast developer registration fee in section 4);
- a release;
- any device access, discovery or connection.

## 1. Scope after the decisions

| App | In scope for displays | Why | Evidence |
|---|---|---|---|
| Windows travel shell | **Yes** | Leaves the house (travel laptop). | `desktop/src-tauri/src/main.rs:179` (tabbed travel shell), `desktop/src-tauri/tauri.windows.conf.json`; session via Access service token, `server/services/operator-access.js:9-14` |
| Android app | **Yes** | Leaves the house (Robert's phone). | `/Users/robertwashko/Projects/Nexus-Mobile-Android/app.json:27-36`; `dashboard/docs/mobile-shell.md:18-21` (service-token `CF_Authorization` cookie primed into the WebView) |
| Browser dashboard (as a launcher) | No | Robert: "I don't need it from the web version." The dashboard pages remain what both shells render, so the four views are still built as dashboard pages. | Comment 1 |
| The Nexus.app (Mac) | No | Does not leave the house. Allowed only as a test-inventory helper under the ruling. | Comments 1 and 6 |
| Praxis iPad Home Hub | No | "ipad is not in scope, it never leaves the house". | Comment 6 |
| iPhone (no app exists) | No | "my phone" is the Android phone. | Comment 6, answer 1 |

Device protection (old Part A) is **deferred**: "skip protection for now, focus on displays". It is kept unchanged in Appendix H2 for when Robert reopens it.

## 2. The four views (all approved)

Each view is a presentation-safe, read-only dashboard page. It shows no inbox questions, credentials, private messages or email content, because the screen is usually in a shared room.

| # | View | Today | Notes |
|---|---|---|---|
| 1 | Ambient bridge | **Implemented** as Ambient Mode: fullscreen live core, clock, presence and latest stream event, with a Screen Wake Lock (`dashboard/src/components/bridge/ambient-mode.tsx:1-9`, wake lock at `:68-70`). | It is an overlay today, not its own route, so it needs a presentable route. |
| 2 | Current Focus / active work and the task board, read-only | Source pages exist (`dashboard/src/app/page.tsx`, `dashboard/src/app/task-board/page.tsx`). | A read-only presentation variant is new work. |
| 3 | A single document under review | Source page exists (`dashboard/src/app/documents/[id]`). | Must present an **exact revision** (document id plus revision id, with its content hash shown), never "whatever is current". If a newer revision lands while presenting, the screen keeps the presented revision and the controller is told. Review controls (comments, Finish, approve) are not rendered. |
| 4 | Calendar or day plan | Source page exists (`dashboard/src/app/calendar/page.tsx`). | Read-only, with event details limited to the presentation-safe set. |

## 3. Two kinds of display route, and what authentication each uses

The main design fact behind comment 4 is that "the display" is one of two very different things.

### 3.1 Sender-rendered display: existing authentication, nothing new

Here the signed-in Windows or Android app renders the view itself, and the external screen only shows pixels the app produced. The display never talks to Nexus. Routes:

- a wired monitor or TV (USB-C, HDMI, a dock);
- a window placed fullscreen on a chosen monitor;
- OS mirroring or extension the user starts from the OS picker, such as Windows "Connect to a wireless display" (Win+K, Miracast) or Android screen cast from Quick Settings;
- an Android `Presentation` shown on a presentation display.

For all of these, **Robert's existing authentication is reused as is**. On Windows that is the travel shell's Access service-token session (`operator-access.js:9-14`). On Android it is the shell's service-token `CF_Authorization` cookie in the WebView (`dashboard/docs/mobile-shell.md:18-21`). No credential reaches the screen, and nothing new is minted. This route category fully satisfies comment 4.

### 3.2 Separate receiver: does not inherit the sender's login

Here the screen runs its own browser engine, with its own cookies, and fetches the view from Nexus itself. Two cases:

- a Google Cast **Web Receiver**, an HTML5 app the Chromecast loads;
- a **smart-TV browser** pointed at a Nexus URL.

The sender's sign-in does not travel with the request. Cookies in the Android WebView or the WebView2 profile stay on that device.

**Correction to the earlier claim.** Revision 37b232e2 said a TV "cannot complete a Cloudflare Access one-time-PIN login". That is too absolute. Access one-time PIN is an ordinary web flow: enter an email, receive a code by email, paste it in. Cloudflare's documentation states no device or browser requirement for it, so some smart-TV browsers can complete it. The accurate statements are these:

- **No inheritance.** A receiver must never be assumed to inherit the sender's login.
- **Cast receivers have no practical way to sign in.** A Cast Web Receiver has no practical interactive sign-in, because it is driven by the sender, not typed into.
- **A TV-browser login would breach the ruling.** Even where a TV browser can complete a full Access login, that would give a shared-room device a full Nexus session. Robert's ruling rules that out ("no full login or general operator authority goes to the TV").

**What a receiver gets instead (Robert's ruling, section 0.2).** A temporary pairing, started from the signed-in controller app. The pairing must be:

- scoped to the one selected read-only view (and, for a document, the exact revision);
- not an account;
- stoppable and revocable from the controller;
- time-limited.

**Unresolved and owned by task 9cae1b0e-cba3-4580-a83a-1c3222404dbe.** Three design questions remain open:

- the concrete pairing credential (format, lifetime, binding to view and revision);
- how a receiver reaches that one view through Cloudflare Access without a full Access session (for example a narrowly scoped Access policy or service path);
- the pairing gesture (for example a short code or QR shown on the TV and confirmed on the controller).

Robert approved the *scope* of pairing, not a specific mechanism. This assessment proposes no new auth architecture and marks the mechanism **unresolved** until that task's design is reviewed.

## 4. Capability matrix for Windows and Android

The "Evidence" column cites section 10 sources or local files. Nothing in either app presents to an external display today: no monitor, `Presentation`, Cast or projection call exists in `desktop/src-tauri/src` or the Android app's source, and the Android `package.json` has no Cast or display dependency (verified locally by search).

### 4.1 Windows travel shell (Tauri 2, WebView2)

| Route | Kind | Status | Evidence and caveats |
|---|---|---|---|
| W1. List the monitors the OS shows (built-in, wired, and a wireless display once connected) | Sender-rendered | **Platform-supported**, not implemented | Sourced: Tauri `availableMonitors()` (since 1.0) returns `Monitor` objects with `name` (string or null), `position`, `size` and `scaleFactor`. Verified locally: `core:window:default` includes `allow-available-monitors`, and the shell grants `core:default` (`desktop/src-tauri/capabilities/default.json`). Caveat: that capability says remote tunnel content "has no Tauri access", so the dashboard page cannot call it directly. Listing must run in a local shell page or a native command and be relayed. `name` may be null or generic, so friendly names are unverified until tested on the laptop. |
| W2. Open a chosen view fullscreen on a chosen monitor | Sender-rendered | **Requires additional component** | Sourced: `setFullscreenOnMonitor(position)` exists "since 2.12.0" and "Requires the `core:window:allow-set-fullscreen-on-monitor` permission (not included in `core:window:default`)". Verified locally: the shell is locked to tauri 2.11.5 (`desktop/src-tauri/Cargo.lock`), so this needs either a Tauri upgrade to 2.12+ plus that permission, or an equivalent native command (create a window, position it on the monitor, then fullscreen it) with its own permission grants. |
| W3. Miracast wireless display picked by the user (Win+K, "Connect to a wireless display") | Sender-rendered (OS) | **Platform-supported** (OS picker) | Sourced: Microsoft support documents Win+K to a display that "supports Miracast", or to a Miracast adapter. Once connected in Extend mode, the display should appear as a monitor so W1 and W2 apply. That last step is platform knowledge, to be proven on the laptop. The laptop's Miracast support is unverified. |
| W4. App-initiated Miracast without the OS picker | Sender-rendered | **Unknown** | Sourced: WinRT `Windows.UI.ViewManagement.ProjectionManager` can send an app view to "the projector or other secondary display" (`StartProjectingAsync`, `RequestStartProjectingAsync`, `StopProjectingAsync`). It is a UWP view-management API, and its use from a Tauri/WebView2 desktop window was not established. For Praxis commands, treat the OS picker as the consent step (section 5). |
| W5. Google Cast to a Chromecast or Google TV | Separate receiver | **Requires additional component**, Windows sender path **unknown** | Sourced: the Cast overview lists sender apps on Android, iOS and Web (Chrome); there is no Windows native sender SDK. Whether the Cast Web Sender works inside WebView2 was not established. The receiver side needs the custom Web Receiver described under A4. |
| W6. AirPlay to an Apple TV | Separate receiver | **No vendor-supported path** (requires a third-party component; not recommended) | Sourced: Apple's AirPlay article covers iPhone and iPad as sources only, and mentions neither Windows nor Android. tvOS has no general web browser (platform knowledge), so the TV-browser route does not reach an Apple TV either. An Apple TV is reachable from these apps only through a third-party AirPlay sender or a future tvOS app. Both are out of this scope and left **unresolved**. |
| W7. Smart-TV browser paired to one view | Separate receiver | **Requires additional component** | The TV browser must load a Nexus URL and be enrolled by explicit pairing. It is never auto-discovered, and it cannot be listed by W1. Needs the pairing service and receiver view from section 3.2 (mechanism unresolved). Which browser the "Living Room TV" runs, if any, is unverified. |

### 4.2 Android app (Expo / React Native shell, `react-native-webview`)

| Route | Kind | Status | Evidence and caveats |
|---|---|---|---|
| A1. Wired USB-C / HDMI display via `Presentation` | Sender-rendered | **Platform-supported**, **requires additional component** | Sourced: `Presentation` is "a special kind of dialog whose purpose is to present content on another display". Suitable displays come from `DisplayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)` or `MediaRouter.RouteInfo.getPresentationDisplay()`. A presentation "is automatically canceled ... when the display to which it is attached is removed", and it "will occlude other activities on the target display for security reasons". Needs a native module in the Expo shell (none exists) hosting a WebView of the selected view on the presentation display. Whether Robert's phone outputs video over USB-C is unverified (model unknown). |
| A2. OS screen cast or mirroring from Quick Settings | Sender-rendered (OS) | **Platform-supported** (OS) | Platform knowledge. It mirrors the whole phone screen, not just the presentation-safe view, so it is a fallback rather than the target experience. Availability on Robert's phone is unverified. |
| A3. `Presentation` on a wireless display route (`MediaRouter` live-video route) | Sender-rendered | **Unknown** | Sourced: the API supports a selected `ROUTE_TYPE_LIVE_VIDEO` route's presentation display. Whether Robert's phone and the TV expose such a wireless route (for example Miracast) is hardware-dependent and unverified. |
| A4. Google Cast sender to a custom Web Receiver | Separate receiver | **Platform-supported**, **requires additional component** | Sourced: the Android sender uses `CastContext` with an `OptionsProvider` whose receiver application ID "is used to filter discovery results"; "Device discovery is completely managed by the CastContext", and sessions are "created and torn down automatically in response to user gestures from the MediaRouter dialogs". The Default Media Receiver is "useful for learning and very limited playback scenarios" and "not suitable for production apps", so it cannot show a live document or task view. That needs a **Custom Web Receiver**, which brings four requirements (see the list after this table). The receiver does not inherit the phone's login (section 3.2). |
| A5. AirPlay to an Apple TV | Separate receiver | **No vendor-supported path** | Same finding as W6. Left unresolved. |
| A6. Smart-TV browser paired to one view | Separate receiver | **Requires additional component** | Same as W7. Pairing is started from the phone. |
| A7. In-page Presentation API or Cast Web SDK inside the Android WebView | Either | **Unknown** | Carried from the prior research. No source confirms Android WebView exposes either API, so the native routes A1 and A4 are the plan. |

The Custom Web Receiver in A4 brings these requirements:

- **Registration fee (spending, not approved).** Registering in the Google Cast SDK Developer Console carries "The $5 developer account registration fee", which "is non-refundable".
- **Device registration.** An unpublished receiver works only on devices registered by serial number, which takes 5 to 15 minutes. Reading the TV's serial number is device access.
- **HTTPS hosting.** The receiver page must be hosted over HTTPS.
- **Sender dependency.** The Android shell must add the Cast SDK, which uses Google Play services (platform knowledge).

### 4.3 What this means for "as many of these capabilities as possible"

Ordered by feasibility. Every item is owned by a prepared task in section 7.

1. **Sender-rendered routes first** (W1, W2, W3, A1, with A2 as a fallback). They reuse existing authentication completely and need no receiver, no registration and no new credential. Remaining work: the W2 Tauri upgrade or native command, and the A1 native module.
2. **Then smart-TV browser pairing** (W7, A6). It needs the pairing service and scoped receiver view, which Robert approved in scope and which is unresolved in mechanism. It works from both apps the same way.
3. **Then Cast from Android** (A4). It needs a Custom Web Receiver, the $5 registration, and the TV's serial registration. Each of those needs Robert's explicit go-ahead at that task; none is approved here. Cast from Windows (W5) stays unknown until a sender path is shown to work in WebView2.
4. **Apple TV** (W6, A5) has no supported path from Windows or Android and stays unresolved. Of Robert's listed targets, it is the one these two apps cannot reach with vendor-supported methods today.

## 5. The conversational workflow (comment 5)

Robert's words: "Praxis show me the displays you can see", then "OK, display this document review on X screen".

1. **"Praxis, show me the displays you can see."**
   - Praxis asks the active controller (the Windows shell or the Android app Robert is using) for its current display inventory. Praxis runs on the Mac, so it never lists displays from the Mac's point of view; Mac-side discovery is test inventory only (ruling, section 0.2).
   - The controller reports one entry per target: a stable target ID, the friendly name as the platform reports it, the route kind (sender-rendered or receiver), the route (monitor, wireless display, presentation display, Cast device, paired TV browser) and its availability.
   - Listing never connects, pairs or starts a presentation.
   - Targets the controller cannot see are not listed. That includes an unpaired TV browser, an Apple TV, or a wireless display not yet connected through the OS picker.
2. **"OK, display this document review on X screen."**
   - Praxis resolves "this document review" to an exact document ID and revision ID: the one in front of Robert, or a named one.
   - Praxis resolves "X screen" to one target ID from the last listing. If two targets match, or none does, Praxis asks which; it never guesses.
   - **Sender-rendered target:** the controller opens the view on that monitor or presentation display using its existing session.
   - **Receiver target:** the controller starts the temporary view-only pairing (section 3.2). Any OS or Cast dialog that the platform requires stays a user tap. The Cast SDK creates sessions "in response to user gestures from the MediaRouter dialogs", so whether a session can start from a voice command alone is **unknown**, and Praxis says so instead of claiming the screen is live.
   - **Wireless display that is not yet connected (Win+K, Android screen cast):** Praxis tells Robert to pick it in the OS picker, then lists again.
3. **"Stop."**
   - From Praxis or the controller, this ends the presentation and, for a receiver, revokes the pairing.
   - The pairing also expires on its own.
   - Praxis reports the stopped state that the controller confirmed, not an assumed one.

The command layer is prepared task b5170694-aae7-49ec-aac0-c7fd63077b91. It depends on the controller contracts in 9cae1b0e (Windows plus the shared contract) and b0d2746d (Android).

## 6. Answered questions and remaining unresolved items

No questions are asked in this revision. Robert's answers (section 8) and the operator ruling (section 0.2) settle scope, platforms, targets, views, authentication and test devices.

The remaining **unresolved** items belong to the implementation tasks. They are settled either by authorized testing or by that task's reviewed design, not by new questions:

- the pairing mechanism and the Access path for receivers (section 3.2);
- the TV's receiver protocol and model;
- the phone's video-out support;
- the laptop's Miracast support;
- whether Cast can start without a tap;
- the Apple TV route.

If an implementation task needs a spending or device-access go-ahead, such as the Cast registration fee or reading the TV's serial number, it raises that against the existing inbox query thread ask-robert-e300a46f-5aba-4a2c-8065-bc9ea8f1f090 rather than opening a new questionnaire.

## 7. Prepared implementation tasks (linked, not created or dispatched)

All three were prepared before this revision and are `todo`. This revision does not create, dispatch, re-scope or edit any task.

| Order | Task ID | Project | Title | Depends on | Deliverable |
|---|---|---|---|---|---|
| 0 | 6d6e2638-8fc1-46fa-8545-3ad4d5876dc0 | TheNexus | Apply Robert's Windows and Android display decisions to the capability assessment (this revision) | | this document |
| 1 | 9cae1b0e-cba3-4580-a83a-1c3222404dbe | TheNexus | Present Nexus views on chosen displays from the Windows travel shell | 6d6e2638, be441473-ebd1-4c93-b3a1-9f3e3d3decf4, 91f1f758-4b40-464b-a2a0-29f29de0bf98 | `docs/reviews/travel-displays-windows.md` (key `nexus:travel-displays:windows`) |
| 2 | b0d2746d-d67b-4b1d-bffb-94276055d2aa | Nexus-Mobile-Android | Discover and present to supported external displays from Nexus Android | 6d6e2638, 9cae1b0e | `/Volumes/Projects/Nexus-Mobile-Android-displays/docs/travel-displays-android.md` (key `nexus:travel-displays:android`) |
| 3 | b5170694-aae7-49ec-aac0-c7fd63077b91 | Praxis | Let Praxis discover displays and present a selected Nexus view by name | 9cae1b0e, b0d2746d | `/Volumes/Projects/Praxis/docs/reviews/travel-display-commands.md` (key `praxis:travel-display-commands`) |

Mapping: task 1 owns the shared display contract, the four views, the receiver pairing design, and W1 to W7. Task 2 owns A1 to A7. Task 3 owns section 5.

**Proposed bounded corrections (for Robert or the task owner; not applied here):**

- **C1.** Task 9cae1b0e lists dependency be441473-ebd1-4c93-b3a1-9f3e3d3decf4, "Replace vitality dollars with points across Health Wealth Capital" (Joey Lautrup project). That task has no evident relation to displays and would block the Windows work behind another project. If unintentional, remove it.
- **C2.** Task 9cae1b0e should state the W2 prerequisite: the shell is on tauri 2.11.5, `setFullscreenOnMonitor` needs 2.12.0, and the `core:window:allow-set-fullscreen-on-monitor` permission (or an equivalent native command with explicit grants) is required.
- **C3.** Task b0d2746d should state that the Custom Web Receiver registration ($5, non-refundable) and the TV's serial registration are spending and device access. Both need Robert's go-ahead before they happen.
- **C4.** The receiver's Cloudflare Access path is an authentication design decision. Task 9cae1b0e should present it for review before implementing it, and should keep it within Robert's ruling: one view, no account, revocable, expiring.

## 8. Robert's answers to the earlier questions (replacing old section 2)

| Earlier question | Robert's answer | Effect |
|---|---|---|
| 1. Which phone is "my phone"? | "Android" | Android app in scope; iPhone out. |
| 2. Protection depth? | "skip protection for now, focus on displays" | Part A deferred (Appendix H2). |
| 3. Data sources for alerts? | "n/a we are skipping protections" | Not applicable. |
| 4. Which real displays matter? | "TV with chromecast, apple TV, or other smart TV browsers. don't worry about the mac or ipad" | Targets in section 4. Apple TV has no supported path from these apps (W6, A5). |
| 5. Is the iPad hub in scope? | "ipad is not in scope, it never leaves the house" | iPad out of scope. |

## 9. Test plan (recorded only; not performed by this task)

**Devices.** Robert's Android phone, his Windows laptop, and the receiver named "Living Room TV" (expected on the Mac's network). Their models, OS versions, the TV's receiver protocol and its reachability are **unverified**. The plan does not assume Chromecast, AirPlay or a TV browser from the name.

Each test runs only inside an authorized implementation task.

1. **T1 Discovery from each controller.**
   - On the laptop, the list shows the built-in display plus any attached or Win+K-connected display, with stable IDs.
   - On the phone, the list shows presentation displays and, once A4 exists, Cast devices.
   - The test proves that listing alone starts nothing.
   - Mac-side discovery may confirm that "Living Room TV" exists on the network, but it does not count as T1 evidence.
2. **T2 Pairing.** A receiver is paired from the signed-in controller to one selected view. The receiver holds no account and no full Access session.
3. **T3 Selected-view isolation.** The paired receiver can load only the selected view. The test must show refusal when the receiver:
   - navigates to another route;
   - requests another document or revision;
   - calls any API outside that view.
   No inbox, chat, credential or review controls render.
4. **T4 Controller stop and revoke.** Stopping on the controller (and via Praxis) ends the presentation. After revocation, the receiver's credential is refused.
5. **T5 Expiry.** An unrevoked pairing stops working at its expiry, and the receiver shows an ended state, not stale content.
6. **T6 Exact document-revision handling.**
   - The receiver shows the named revision, with its revision ID and hash visible.
   - A new revision registered mid-presentation does not silently replace it.
   - Presenting a different revision requires a new present action.
7. **T7 Sender-rendered routes reuse existing sign-in.** A wired monitor on each device, Win+K on the laptop if supported, and A1 on the phone if supported all show the view with no new credential minted.
8. **T8 Conversational flow.** "Praxis show me the displays you can see", then "display this document review on Living Room TV", then "stop". The test runs end to end from each controller, with Praxis reporting only confirmed states.

**Explicit blockers to keep open until resolved by evidence:**

- **B1. TV receiver unknown.** The "Living Room TV" receiver protocol and browser are unknown: there may be no Cast receiver, no browser, or it may be an Apple TV.
- **B2. Phone video-out unknown.** The phone's model and its USB-C video-out support are unknown.
- **B3. Laptop Miracast unknown.** The laptop's Miracast support is unknown.
- **B4. OS consent.** The Cast dialog, the Windows wireless-display picker, and any network permission the platform requests must be granted by Robert on the device.
- **B5. Cast registration.** The Cast Developer Console registration and the TV's serial registration need Robert's go-ahead (spending, device access).
- **B6. Access path.** The receiver's Access path is unresolved (section 3.2, C4).
- **B7. Physical presence.** Robert and the devices must be present on the same network for receiver tests.

## 10. Sources and limits (this revision)

Official sources consulted on 2026-10-20 for this revision:

- Tauri v2, `@tauri-apps/api/window` reference (`availableMonitors`, `Monitor` fields, `setFullscreenOnMonitor` since 2.12.0 and its permission): https://v2.tauri.app/reference/javascript/api/namespacewindow/
- Google Cast, Android sender integration (`CastContext`, `OptionsProvider`, receiver application ID, discovery and dialog-driven sessions): https://developers.google.com/cast/docs/android_sender/integrate
- Google Cast, overview (sender platforms; Default, Styled and Custom receivers; Default "not suitable for production apps"): https://developers.google.com/cast/docs/overview
- Google Cast, custom receiver codelab (registration, device serial registration, HTTPS hosting): https://developers.google.com/cast/codelabs/cast-receiver
- Google Cast, registration ($5 non-refundable fee, Custom versus Styled receiver, unpublished receivers on registered devices): https://developers.google.com/cast/docs/registration
- Apple Support, AirPlay from iPhone or iPad (senders are Apple devices only): https://support.apple.com/en-us/102661
- Android Developers, `Presentation` (display choice via `MediaRouter` or `DisplayManager`, cancel on removal, occlusion rule): https://developer.android.com/reference/android/app/Presentation
- Android Developers, media routing (Cast via the Cast SDK, output switcher): https://developer.android.com/media/routing
- Microsoft Learn, `ProjectionManager` (WinRT app-view projection): https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.projectionmanager
- Microsoft Support, screen mirroring and projecting to a wireless display (Win+K, Miracast requirement): https://support.microsoft.com/en-us/windows/screen-mirroring-and-projecting-to-your-pc-or-wireless-display-5af9f371-c704-1c7f-8f0d-fa607551d09c
- Cloudflare, Access one-time PIN (web flow, no stated device requirement): https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- Local code: `desktop/src-tauri/Cargo.lock` (tauri 2.11.5), `desktop/src-tauri/capabilities/default.json` (`core:default`, remote content has no Tauri access), `desktop/src-tauri/gen/schemas/acl-manifests.json` (`core:window` default includes `allow-available-monitors`), `dashboard/docs/mobile-shell.md:18-21`.

These sources support individual methods. None of them shows universal receiver support, and nothing here proves any route works with Robert's specific devices.

Limits of this revision:

- No device, network, display or account was touched; no discovery ran.
- Whether `ProjectionManager` or the Cast Web Sender is usable from the Tauri/WebView2 shell was not established (W4, W5).
- Whether a Cast session can start from a voice command without a dialog tap was not established.
- A2 (Android screen cast) and the tvOS no-browser statement are platform knowledge.
- The pairing mechanism and receiver Access path are deliberately left unresolved for review in task 9cae1b0e.

---

## Appendix H. Historical research (retained from revision 37b232e2; out of scope or deferred)

Everything below is the earlier research, kept so nothing is lost if Robert reopens these areas. It is **not current scope**. Where a statement was corrected, the correction is marked.

### H0. Original request and framing

Robert, in Nexus chat on October 13, 2026 at 14:07 EDT:

> "Another idea, this one for the nexus: add devicw protection functions and tools to each app version. For example, monitor my phone for any incoming hacking attempts and warn me or intercept.  Access external displays that can be accessed in various ways to project what I need"

The filing's heads-up, carried unchanged:

> Idea capture only, not an implementation or dispatch request. Assess each platform's actual security visibility, permissions and prevention capabilities before promising detection or interception; determine supported display connection methods and consent requirements. Keep these two capability areas distinct during later scoping. No device access, monitoring, configuration changes, connections or project-scope changes are authorized by this filing.

So this document does exactly two things: for every Nexus app version it states what each platform actually lets an app see, block and present, with the consent each step needs; and it proposes candidate follow-up slices for Robert to accept or discard. No device was inspected, no monitoring was started, no display was connected, no setting was changed, and no Nexus task was created. The two areas are kept in separate parts (A and B) and their follow-ups are separate lists, as the heads-up requires.

### H1. The Nexus app versions that exist today (original inventory)

Out of scope for displays after comment 1: rows 1, 2 and 5. Rows 3 and 4 are the current scope (section 1).

| # | App version | What it is | Where it runs | Evidence |
|---|---|---|---|---|
| 1 | Browser dashboard | Next.js App Router UI, the canonical cockpit | Any browser; :3000 locally, `https://nexus.vibeshiftai.com` behind Cloudflare Access remotely | `CLAUDE.md` load-bearing map; `dashboard/docs/mobile-shell.md:13-20` (tunnel and Access) |
| 2 | The Nexus.app (Mac) | Tauri 2 app, one WKWebView on `http://localhost:3000`; new windows go to the system browser | Robert's Mac | `desktop/src-tauri/src/main.rs:6` (loader hands over to localhost:3000), `main.rs:166` (`on_new_window`); `desktop/src-tauri/tauri.conf.json` (product "The Nexus", v1.4.0) |
| 3 | Windows travel shell | Same Tauri binary, Windows personality: tabbed webviews on the tunnel host, service-token session, auto-updater | Travel laptop | `main.rs:11`, `main.rs:282` (BRIDGE tab on nexus.vibeshiftai.com); `desktop/src-tauri/tauri.windows.conf.json` (updater endpoint); `server/services/operator-access.js:9-14` (device session) |
| 4 | Android app | Expo / React Native shell hosting the dashboard in `react-native-webview`; permissions limited to notifications, alarms, boot, vibrate | Robert's phone (sideloaded EAS preview APK) | `/Users/robertwashko/Projects/Nexus-Mobile-Android/app.json:27-36`; `dashboard/docs/mobile-shell.md:3-10` |
| 5 | Praxis iPad Home Hub | Native SwiftUI app (iOS 17+), wall-mounted iPad Pro M2, Home Assistant plus Nexus client | Apartment wall | `/Volumes/Projects/Praxis iPad Home Hub/docs/architecture.md:15`; `PraxisHub/NexusClient.swift` exists |

Two consequences shape everything below. First, three of the five surfaces (Mac, Windows, Android) are webview shells around the same dashboard, so any feature built in the dashboard reaches them, but any feature that needs operating-system power has to be built natively in each shell. Second, the iPad hub is a separate Swift codebase and a separate Nexus project; work there is a cross-project change, not a dashboard change. The filing says "each app version" and does not authorize project-scope changes, so the iPad column is assessed but any iPad slice below is marked as needing Robert's scope call.

There is no iPhone app today. `app.json:12` sets `ios.supportsTablet` but no iOS build is evidenced; the iOS rows in Part A describe what an iPhone build would face, because "monitor my phone" might mean a future iPhone.

### H2. Part A: Device protection (deferred: "skip protection for now, focus on displays")

#### A1. Four different things "detect and intercept hacking attempts" can mean

The request bundles four layers. They have very different feasibility, so later scoping should pick among them explicitly.

| Layer | Example threat | Who can actually see it |
|---|---|---|
| A. Attacks on Nexus itself | Someone hammering the Access login, a stolen service token, a forged operator JWT | **Partly visible today; counting attacks needs new telemetry.** Cloudflare Access keeps its own request logs. Nexus refuses operator authority with a fixed category plus check name, but its diagnostic warning is throttled: `server/services/operator-access.js:75` emits at most one `console.warn` per category/check window every 30,000 ms and silently drops repeats inside the window (pinned by `server/__tests__/praxis-operator-provenance.test.js:31-32`, "is rate limited", where two refusals at `:49-50` yield one warning at `:51`, a refusal 29,999 ms later adds none at `:54`, and only the one at 30,000 ms adds a second at `:57`). Those warnings are diagnostics that a refusal kind occurred, not a count of refusals, so they cannot measure an attack burst. |
| B. Device posture | Phone months behind on patches, Advanced Protection off, app tampered with, rooted device | Partly visible to an app through documented APIs (see A2). |
| C. Network traffic on the device | Phishing domains, malicious hosts contacted by other apps | Only through an OS-sanctioned mechanism with explicit user consent. On iPhone/iPad the options differ by tier (see A2): a packet tunnel routes traffic on unsupervised devices, a URL filter (iOS 26+) blocks listed URLs in WebKit/URLSession requests on consumer or managed devices, and a system-wide content filter needs a supervised device. None of them lets an app decrypt other apps' TLS traffic. |
| D. OS compromise and spyware | Zero-click exploits, stalkerware, persistence | Not visible to an ordinary app on any platform. Only OS-vendor features (Android intrusion logging, Apple threat notifications, Lockdown Mode) or forensic tools see this layer. |

The honest headline: Nexus can **warn** about layer A once it records every refusal (today's throttled warnings show that a refusal kind occurred, not how many), and partly about B; it can **block** at layer C only by adopting an OS-sanctioned filter (preferably an existing managed one), and it cannot detect or intercept layer D on any platform. Promising "monitor my phone for hacking attempts and intercept" as a general capability would overstate what any non-OS app can do.

#### A2. Per-platform capability

##### Android app (Nexus-Mobile-Android)

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| Read another app's traffic or memory | Not allowed; app sandbox. | n/a | Platform knowledge |
| Network filtering / interception | `VpnService`: an app can route the device's traffic through itself (local DNS or packet filter). Only one VPN is active at a time, so it would compete with any VPN Robert already uses (for example Cloudflare WARP). | System VPN consent dialog; user can revoke anytime; persistent notification | Platform knowledge |
| DNS-level blocking without building a VPN | Android Private DNS (Settings) pointed at a filtering resolver; no app code needed. | User sets it in Settings | Platform knowledge |
| Device security logs | Android 16 intrusion logging (process starts, DNS queries, outbound connections, ADB and keyguard events) exists, but it is an OS feature under Advanced Protection, retrieved by the user from Settings, not an app API. The underlying `SecurityLog` API is limited to device-owner/profile-owner (managed) apps. | Advanced Protection on; user retrieves logs | Sourced (Google support, The Hacker News, MVT docs) for intrusion logging; the `SecurityLog` owner restriction is platform knowledge |
| Know whether Advanced Protection is on | `AdvancedProtectionManager` status query plus change notifications. | `QUERY_ADVANCED_PROTECTION_MODE` permission | Sourced (secondary report; signature not confirmed against developer.android.com) |
| App and device integrity | Play Integrity API verdicts (device integrity, app recognized). Note: the phone runs a sideloaded EAS APK, so the "recognized by Play" verdict would fail by design unless distributed through Play. | None from user; Play Console setup | Platform knowledge |
| OS patch level, root/developer-options state | `Build.VERSION.SECURITY_PATCH` and settings reads give posture hints. | None | Platform knowledge |
| Read SMS / notifications to spot phishing | `NotificationListenerService` or SMS permissions are possible on a sideloaded app, but Android 13+ "restricted settings" blocks them for sideloaded apps until the user explicitly allows; they also hand Nexus a large privacy surface. | Special-access settings, restricted-settings override | Platform knowledge |
| Warn the user | The shell declares `POST_NOTIFICATIONS` (`app.json:31`) and Nexus has a push path. A manifest declaration does not grant the permission: on Android 13 (API 33) and higher it is a runtime permission, notifications for a newly installed app are off until the user allows them in the system dialog, and the user can revoke it at any time. Whether Robert's phone currently grants it was not checked (no device access). | Runtime consent required on Android 13+; current grant on Robert's phone unverified | Verified locally (declaration only); sourced (Android notification-permission doc) for the runtime rule |

##### iPhone (no app yet) and the iPad Home Hub

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| System-wide content filter (`NEFilterDataProvider`) | iOS 9.0+ on supervised devices only; iOS 16.0+ also per-app on managed (MDM) devices; iOS 15.0+ through Screen Time, but only on a child device in an iCloud family with parent authorization and the Family Controls entitlement. A consumer, unsupervised adult iPhone cannot run it, and the Screen Time path is parental control, not threat detection. | Supervision, MDM, or Family Controls child authorization | Sourced (Apple TN3134, "Deploying a content filter provider"; Apple developer forums) |
| URL filter (`NEURLFilterManager` + `NEURLFilterControlProvider`), new in iOS 26 | iOS 26.0+ and macOS 26.0+, app extension, no supervision listed; Apple describes it as working for "both consumer and managed deployments". The system checks every URL request made through WebKit or `URLSession` against the app's block list: an on-device Bloom prefilter first, then a privacy-preserving lookup on a Private Information Retrieval (PIR) server the developer must run (a separate Privacy Pass issuer URL is optional; without one the PIR server fills that role). Other networking stacks are covered only if the app voluntarily asks `NEURLFilter.verdict(for:)`. It matches URLs against a list; it does not inspect payloads or arbitrary encrypted traffic, and it does not see apps using their own sockets. | User enables the filter configuration; developer registers the URL filter configuration with Apple and operates the PIR server | Sourced (Apple "URL filters", `NEURLFilterManager`, `NEURLFilter`, TN3134 "Deploying a URL filter provider", "Filtering traffic by URL" sample) |
| Encrypted DNS settings (`NEDNSSettingsManager`) | An app can offer a DNS-over-HTTPS/TLS configuration (for example a filtering resolver); the user enables it in Settings. Blocks known-bad domains but does not inspect traffic. | User enables in Settings > VPN & Device Management > DNS | Platform knowledge |
| Packet tunnel VPN (`NEPacketTunnelProvider`) | iOS 9.0+, works on unsupervised devices with user consent (per-app mode requires a managed device); one active VPN at a time. It can route and drop packets or DNS lookups, but other apps' HTTPS stays encrypted end to end, so it sees destinations, not content. Apple's TN3120 limits the expected use to real VPN tunnels, so a filtering-only tunnel risks App Review rejection. | VPN configuration consent | Sourced (Apple TN3134, "Deploying a packet tunnel provider") for versions and supervision; TLS and TN3120 points are platform knowledge |
| Detect spyware / OS compromise | Not available to apps. Apple's own threat notifications and Lockdown Mode are the OS-level answers; Nexus can only remind and link to them. No documented API was found that lets an app read whether Lockdown Mode is on. | User-controlled | Platform knowledge; Lockdown Mode API absence not confirmed |
| App integrity | App Attest / DeviceCheck attest that requests come from a genuine copy of the Nexus app. | None from user | Platform knowledge |
| iPad hub specifics | A wall-mounted shared device in a home: the realistic protection value is its own posture (passcode, Guided Access, OS updates) and protecting the Home Assistant and Nexus credentials it holds, not monitoring other devices. Supervision via Apple Configurator is possible for a dedicated device, which would unlock content filtering, but that is a device-management decision for Robert. | Supervision decision | Platform knowledge |

##### The Nexus.app (Mac)

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| System event monitoring | Endpoint Security framework: process, file and auth events system-wide. Requires an Apple-granted entitlement (`com.apple.developer.endpoint-security.client`), a system extension and Full Disk Access. | Apple entitlement request; user approval in System Settings | Platform knowledge |
| Network filtering | Network Extension content filter or DNS proxy as a system extension (macOS 10.15+); unlike iOS, no supervision needed. The URL filter provider is also available on macOS 26.0+. | Developer ID signing, user approves the extension | Sourced (Apple TN3134) for versions and restrictions; approval flow is platform knowledge |
| Built-in protections | XProtect, Gatekeeper, FileVault, firewall status can be read and reported. | None or admin for some reads | Platform knowledge |
| Current app posture | The Tauri app requests only `core:default` IPC (`desktop/src-tauri/capabilities/default.json`) and only a microphone purpose string (`desktop/src-tauri/Info.plist:9`). Any protection feature would add new entitlements, signing requirements and permissions to an app that is deliberately minimal today. | n/a | Verified locally |

##### Windows travel shell

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| Antivirus / firewall state | Windows Security Center status can be queried (WMI `SecurityCenter2`). | None | Platform knowledge |
| Event monitoring | Windows event logs (failed sign-ins, Defender detections) are readable with appropriate rights; a driver-level filter (WFP) needs signing and admin. | Admin for many logs | Platform knowledge |
| Current app posture | Service-token session per device, pinned in `NEXUS_OPERATOR_DEVICE_IDS` (`server/services/operator-access.js:9-14`). Losing the laptop means losing that token, which makes "revoke this device" a real protection feature (A3 item 2). | n/a | Verified locally |

##### Browser dashboard

A web page cannot see the device's traffic, other tabs, or OS security state. Its protection role is limited to being the place where alerts and posture from the other layers are displayed.

#### A3. What is realistically buildable, ranked by value per effort

These are candidates, not commitments.

1. **Nexus attack alerts (layer A).** Surface what Nexus can see: bursts of Access denials, operator-auth refusals by check name, service-token use from an unexpected device ID, sign-ins from a new country. Prerequisite: today's refusal warnings are throttled diagnostics (`operator-access.js:75`, one warning per category/check per 30 s, no claims), so burst detection needs new per-refusal telemetry, such as a counter or event per refusal with category, check and timestamp, kept separate from the throttled log and still free of claims and tokens. Deliver as an actionable alert to every app version through the existing push and chat channels. Detection runs on the Nexus server and reads nothing from Robert's devices, so it needs no device permission; delivering the alert as a phone notification still depends on each app's notification consent (for example the Android 13+ runtime `POST_NOTIFICATIONS` grant, whose current state is unverified), and in-app chat remains the fallback channel. This is the only part of "incoming hacking attempts" Nexus can observe directly. Data source decision: Nexus server logs only, or also read-only Cloudflare Access request logs (a read-only analytics token is known to exist; using it is still "monitoring" and needs Robert's yes).
2. **Device inventory and revoke.** A cockpit list of the devices holding Nexus credentials (Android service token, Windows travel token, iPad hub credentials, Mac localhost), last-seen times, and a revoke path that rotates the Cloudflare service token. This is the practical "intercept" for a lost or compromised device: cut its access to Nexus.
3. **Device posture panel (layer B).** Each native shell reports a small, privacy-minimal posture record: OS version and security patch level, Advanced Protection on/off (Android), app integrity verdict (Play Integrity / App Attest), shell version versus latest. Nexus warns when posture degrades. Each shell needs its own native code and permission review.
4. **Guided OS protections (layers C and D).** Rather than building an interceptor, a checklist with deep links: Android Advanced Protection and intrusion logging, Private DNS with a filtering resolver, Apple Lockdown Mode, Safety Check, macOS firewall and FileVault, Windows Defender status. Optionally, the on-demand MVT (Mobile Verification Toolkit) scan procedure if Robert ever suspects spyware.
5. **Managed network filtering (layer C), only if Robert wants blocking.** Adopt an existing managed filter (for example Cloudflare Gateway DNS with the WARP client, since Nexus already runs on Cloudflare Access) instead of a home-built `VpnService`. A home-built interceptor would become a high-value target holding all of Robert's traffic, compete with other VPNs, and cost battery; a managed filter gives blocking plus logs Nexus could summarize. This is a configuration change on Robert's devices and account, so it needs Robert's explicit decision and is not authorized by this filing.

**Should not be promised:** detection of zero-click exploits or spyware by a Nexus app; inspection or decryption of other apps' encrypted traffic on any platform; system-wide content filtering on an unsupervised iPhone or iPad. What is possible there, with user consent, is narrower and should be described as such: a packet tunnel that routes traffic and can drop destinations, or (iOS 26+) a URL filter that blocks listed URLs in WebKit and `URLSession` requests only; reading SMS or other apps' notifications as a default feature; any automatic blocking action without Robert in the loop.

#### A4. Risks specific to protection features

- Every permission added to a shell enlarges the attack surface of the app that holds Robert's Nexus credentials. The Mac app's deliberately minimal IPC (`capabilities/default.json`) is a feature worth keeping.
- Posture and network data are sensitive. Anything collected should stay on Robert's own Nexus server, have a retention limit, and never enter Praxis prompts by default.
- Alert fatigue: internet-facing hosts see constant background scanning; alerts need thresholds (layer A) or they will train Robert to ignore them.

### H3. Part B: External displays (original analysis; superseded by sections 2 to 5)

#### B1. Connection methods and who owns the consent (original)

| Method | Typical targets | Consent model | Can an app drive it? |
|---|---|---|---|
| Wired (USB-C / HDMI / Thunderbolt) | Monitors, TVs | Physical connection; OS shows the display | Yes: native apps can place a window or scene on the second display |
| AirPlay | Apple TV, AirPlay 2 TVs, Macs | User picks the receiver in the system picker | Mirroring is OS-only; apps can offer the AirPlay route picker and render a dedicated external scene |
| Google Cast | Chromecast, Google TV, Cast-enabled TVs | User picks in the Cast dialog | Yes, via Cast SDK (native) or Cast Web SDK / Presentation API in Chrome |
| Miracast | Many Windows-compatible TVs and dongles | Windows "Project" (Win+K) picker | OS-level; apps generally do not drive it |
| Sidecar | iPad as a Mac display that extends or mirrors the Mac's desktop | User-initiated from macOS | OS-only |
| Universal Control (not a display method) | Up to two other nearby Macs or iPads (macOS 12.4+, iPadOS 15.4+, same Apple Account with two-factor authentication, within 10 m) | User-initiated; one keyboard and pointer move across devices | OS-only; each device keeps showing its own screen and apps, so it shares input, not a display |
| Open a URL on the display device | Smart-TV browsers, a spare laptop, a kiosk tablet | Whoever is at that device signs in | Nexus provides a view; the device must authenticate (see B4) |

In every case the operating system's picker (or the physical cable) is the consent step. Nexus should never connect to a display on its own; the follow-ups below only ever start from a user action.

Note added in this revision: the AirPlay row applies to Apple senders. From the in-scope Windows and Android apps there is no vendor-supported AirPlay sender (section 4, W6 and A5).

#### B2. Per-app-version capability (original)

The Windows and Android rows are superseded by section 4. The other rows are out of scope.

| App version | Practical display options | Notes | Confidence |
|---|---|---|---|
| Browser dashboard | Fullscreen API on any display; Window Management API (`getScreenDetails`) to open a view on a chosen second screen in Chromium browsers, behind a "window management" permission prompt; Presentation API to Cast devices from Chrome; Remote Playback API / AirPlay for media elements in Safari. | Window Management and Presentation are Chromium-only; Safari/WebKit does not implement them. Presentation and Remote Playback are W3C Second Screen specs, with the Open Screen protocol still a working draft. | Sourced (W3C TR pages, Chrome blog) for spec status; browser coverage is platform knowledge to re-check on MDN |
| The Nexus.app (Mac) | Native: Tauri can enumerate monitors and open a second window positioned on a chosen monitor; macOS mirroring and AirPlay to Apple TV are user-driven from Control Center. | WKWebView does not offer the Window Management or Presentation APIs, so a "present on second screen" feature has to be a small native Tauri command, not dashboard JavaScript. | Platform knowledge |
| Windows travel shell | Same Tauri multi-window approach; Win+K Miracast and wired displays are OS-driven. | Same native-command approach covers both Tauri personalities. | Platform knowledge |
| Android app | Android screen cast / mirroring from Quick Settings (OS-level, no app work); native Cast sender via Cast SDK in the shell; Android `Presentation` class for a wired or wireless secondary display; recent Android versions add connected-display desktop windowing on supported phones. | The dashboard runs inside `react-native-webview`; this research found no evidence that Android WebView exposes the Presentation API or Cast Web SDK, so casting a dashboard view would be native shell work. Treat WebView support as unconfirmed. | Platform knowledge; WebView gap unconfirmed |
| Praxis iPad Home Hub | iPad Pro M2 drives external displays over USB-C, supports Stage Manager extended display, and AirPlay. SwiftUI can declare an external-display scene so the hub shows a different view on the TV than on the wall. | The hub already declares a scene manifest (`PraxisHub/Info.plist:49`) and uses `UIScreen.main` for brightness (`PraxisHub/Managers/BatteryManager.swift:14`); no external-display scene exists today. Cross-project work. | Verified locally (current state); platform knowledge (capability) |

#### B3. What content to present (original; all four approved, see section 2)

The dashboard already has one display-oriented surface: Ambient Mode, a fullscreen overlay with the live core, clock, presence and latest stream event, holding a Screen Wake Lock so the display stays on (`dashboard/src/components/bridge/ambient-mode.tsx:1-9`, wake lock at `:68-70`). It is the natural starting point for "project what I need". Candidate presentable views, in rough order of usefulness:

1. Ambient bridge (exists) on a wall TV or spare monitor.
2. Current Focus / active work and the task board, read-only.
3. A single Document under review (Markdown, PDF, images, video) for walking through a deliverable on a big screen.
4. Calendar or day plan.

A presentation mode should default to a **presentation-safe** view: no inbox questions, credentials, private messages or email content, because external screens are often in shared rooms.

#### B4. Authenticating a display (original, corrected in this revision; superseded by section 3)

*Corrected:* the original text said a TV or Cast receiver "cannot complete a Cloudflare Access one-time-PIN login". Some smart-TV browsers can complete that web flow; a Cast Web Receiver has no practical interactive sign-in. Either way, a receiver must not be assumed to inherit the sender's login, and Robert's ruling forbids giving it a full login.

The rest of the original reasoning stands: any "open Nexus on that screen" path for a separate receiver needs a deliberate display credential, for example a short-lived, read-only, single-view token minted from a device where Robert is already signed in, scoped to the presentation-safe view and revocable. Mirroring and wired displays avoid this entirely because the authenticated device renders the content. The original text tied revocation to the device inventory (A3 item 2), which is now deferred; in current scope, revocation is from the controller (section 3.2).

#### B5. Recommended display approach (original; superseded by sections 4.3 and 5)

Start with what needs no new credentials: (1) a presentation-safe "Present" view in the dashboard, usable fullscreen on any wired or mirrored display; (2) a native "Open on second display" command in the Tauri app for the Mac and Windows shells. Add Cast from the Android shell, an iPad external-display scene, or token-based remote displays only after Robert says which physical displays Robert actually wants to use.

### H4. Original questions (answered; see section 8)

1. **Phone.** Which phone is "my phone": the current Android device running the Nexus shell, or a future iPhone? The feasibility differs sharply (A2).
2. **Protection depth.** Warn-only (A3 items 1 to 4), or also block (item 5, a managed DNS/network filter that changes device configuration)?
3. **Data sources.** May Nexus read Cloudflare Access request logs for alerts, or only its own server logs?
4. **Displays.** Which real displays matter: a TV with Chromecast or Apple TV, a monitor on the Mac, the iPad hub driving a TV, a smart-TV browser?
5. **iPad scope.** Is the Praxis iPad Home Hub in scope for "each app version", given it is a separate project?

### H5. Original candidate follow-up slices (not filed)

The device protection slices are deferred. The display slices are superseded by the prepared tasks in section 7: D1 and D2 (Windows) are in 9cae1b0e, D3 is in b0d2746d, D4 is out of scope (iPad), and D5 is replaced by the ruled temporary pairing in 9cae1b0e.

**Device protection (deferred)**
- P1. Nexus attack alerts from operator-auth refusals and Access denials, with thresholds, delivered to all apps. Includes the new per-refusal telemetry (a counter or event for every refusal, independent of the 30 s throttled warning at `operator-access.js:75`, carrying no claims or token values). Acceptance: in an isolated stack, a synthetic burst of N refused operator tokens inside one 30 s window is recorded as N refusals while the diagnostic log still shows one warning, and produces exactly one alert; normal traffic produces none.
- P2. Device inventory with last-seen and service-token revoke. Acceptance: revoking a device's token makes its next request fail and the cockpit shows it revoked.
- P3. Android posture report (patch level, Advanced Protection state) in the shell, opt-in. Acceptance: posture appears in the cockpit; no other data leaves the phone.
- P4. Guided protections checklist page with deep links per platform.
- P5 (needs Robert's explicit yes). Managed DNS/network filtering rollout and a Nexus summary of its block log.

**External displays (superseded)**
- D1. Presentation-safe "Present" view (ambient, focus, board, single document) with fullscreen entry. Acceptance: no inbox, chat or credential content renders in the view.
- D2. Tauri "Open on second display" command for Mac and Windows shells. Acceptance: with two monitors, the view opens on the chosen monitor; with one, the command explains why it is unavailable.
- D3. Android Cast sender in the shell, or document the OS mirroring path if that suffices.
- D4 (needs iPad scope call). iPad hub external-display scene showing a chosen Nexus view on a connected TV.
- D5 (needs security review with Part A). Short-lived read-only display tokens for screens that cannot sign in.

### H6. Original sources and limits

External sources consulted on 2026-10-20:

- Google support, "Log your Android device activity with Advanced Protection": https://support.google.com/android/answer/16927813
- The Hacker News, Android intrusion logging rollout (May 2026): https://thehackernews.com/2026/05/android-adds-intrusion-logging-for.html
- Android Authority, Android 16 intrusion logging: https://www.androidauthority.com/android-16-intrusion-logging-3556876
- Mobile Verification Toolkit, intrusion logs: https://docs.mvt.re/en/latest/android/intrusion_logs/
- Bayton, Advanced Protection FAQ (secondary, for `AdvancedProtectionManager`): https://bayton.org/android/android-enterprise-faq/what-is-advanced-protection-mode/
- Apple developer forums on content filter supervision: https://developer.apple.com/forums/thread/692597 , https://developer.apple.com/forums/thread/732385 , https://developer.apple.com/forums/thread/827318
- W3C Remote Playback API: https://www.w3.org/TR/remote-playback/
- W3C Open Screen Application Protocol (2026 working draft): https://www.w3.org/TR/openscreen-application/
- Chrome developer blog, Google Cast for Chrome on Android: https://developer.chrome.com/blog/presentation-api

Added in the QA repair round, consulted 2026-10-20:

- Apple TN3134, Network Extension provider deployment (per-provider minimum OS and supervision/MDM restrictions; revised 2025-08-19 to add URL filters): https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment
- Apple, URL filters (WebKit and `URLSession` coverage, Bloom prefilter plus PIR server, "consumer and managed deployments"): https://developer.apple.com/documentation/networkextension/url-filters
- Apple, `NEURLFilterManager` (iOS/iPadOS/macOS 26.0) and `NEURLFilter` (voluntary verdict API for other networking stacks): https://developer.apple.com/documentation/networkextension/neurlfiltermanager , https://developer.apple.com/documentation/networkextension/neurlfilter
- Apple sample, Filtering traffic by URL (PIR server and optional Privacy Pass issuer configuration): https://developer.apple.com/documentation/networkextension/filtering-traffic-by-url
- Apple Support, Use Universal Control (input shared across devices that each show their own apps; Sidecar extends or mirrors a Mac desktop): https://support.apple.com/en-us/102459
- Android Developers, Notification runtime permission (`POST_NOTIFICATIONS` runtime permission on Android 13 / API 33+, off by default for new installs, revocable): https://developer.android.com/develop/ui/compose/notifications/notification-permission
- Local code: `server/services/operator-access.js:70-80` (throttled `reject`), `server/__tests__/praxis-operator-provenance.test.js:31-61` (rate-limit test; `npx jest server/__tests__/praxis-operator-provenance.test.js -t "operator diagnostics"` gave 4 passed, 131 skipped).

Limits of the original research:

- No official developer.android.com page for the intrusion detection API was found; the `AdvancedProtectionManager` permission name comes from a secondary source.
- No source was found on whether an app can read Lockdown Mode state; treated as unavailable until confirmed.
- Current browser coverage of the Window Management, Presentation and Remote Playback APIs, and Android WebView's Presentation/Cast support, were not confirmed today; check MDN and Chrome Platform Status before scoping D1 to D3.
- Rows marked "platform knowledge" were not re-verified today and must be re-checked when their slice is scoped.
- The URL filter API is new in iOS/macOS 26; App Review and entitlement requirements beyond the registration step in Apple's overview, the cost of running a PIR server, and coverage of browsers or apps that use their own networking stack instead of WebKit or `URLSession` (they participate only voluntarily) were not assessed. Sidecar's own minimum OS versions are in a separate Apple article that was not consulted.
- The current notification grant on Robert's Android phone, and the phone's Android version, were not checked; no device was accessed.
- No device, account, network or display was touched to produce this document.
