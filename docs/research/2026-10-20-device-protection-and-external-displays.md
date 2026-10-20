# Device protection and external displays across the Nexus apps: capability assessment

**Task:** 3f35e87a-dfd8-42c7-aa4a-40c0c712b55f (idea capture, exploration only)
**Prepared:** 2026-10-20
**Status:** research for later scoping. Nothing here is implemented, dispatched or filed.

## 0. What was asked, and what this document is not

Robert, in Nexus chat on October 13, 2026 at 14:07 EDT:

> "Another idea, this one for the nexus: add devicw protection functions and tools to each app version. For example, monitor my phone for any incoming hacking attempts and warn me or intercept.  Access external displays that can be accessed in various ways to project what I need"

The filing's heads-up, carried unchanged:

> Idea capture only, not an implementation or dispatch request. Assess each platform's actual security visibility, permissions and prevention capabilities before promising detection or interception; determine supported display connection methods and consent requirements. Keep these two capability areas distinct during later scoping. No device access, monitoring, configuration changes, connections or project-scope changes are authorized by this filing.

So this document does exactly two things: for every Nexus app version it states what each platform actually lets an app see, block and present, with the consent each step needs; and it proposes candidate follow-up slices for Robert to accept or discard. No device was inspected, no monitoring was started, no display was connected, no setting was changed, and no Nexus task was created. The two areas are kept in separate parts (A and B) and their follow-ups are separate lists, as the heads-up requires.

**Confidence labels used below.** *Verified locally* means read from a file in this machine's repos (path:line given). *Sourced* means confirmed by a source listed in section 4 during this research. *Platform knowledge* means established platform behavior stated from prior knowledge and not re-checked today; each such claim should be re-verified against current vendor docs when its slice is scoped.

## 1. The Nexus app versions that exist today

| # | App version | What it is | Where it runs | Evidence |
|---|---|---|---|---|
| 1 | Browser dashboard | Next.js App Router UI, the canonical cockpit | Any browser; :3000 locally, `https://nexus.vibeshiftai.com` behind Cloudflare Access remotely | `CLAUDE.md` load-bearing map; `dashboard/docs/mobile-shell.md:13-20` (tunnel and Access) |
| 2 | The Nexus.app (Mac) | Tauri 2 app, one WKWebView on `http://localhost:3000`; new windows go to the system browser | Robert's Mac | `desktop/src-tauri/src/main.rs:6` (loader hands over to localhost:3000), `main.rs:166` (`on_new_window`); `desktop/src-tauri/tauri.conf.json` (product "The Nexus", v1.4.0) |
| 3 | Windows travel shell | Same Tauri binary, Windows personality: tabbed webviews on the tunnel host, service-token session, auto-updater | Travel laptop | `main.rs:11`, `main.rs:282` (BRIDGE tab on nexus.vibeshiftai.com); `desktop/src-tauri/tauri.windows.conf.json` (updater endpoint); `server/services/operator-access.js:9-14` (device session) |
| 4 | Android app | Expo / React Native shell hosting the dashboard in `react-native-webview`; permissions limited to notifications, alarms, boot, vibrate | Robert's phone (sideloaded EAS preview APK) | `/Users/robertwashko/Projects/Nexus-Mobile-Android/app.json:27-36`; `dashboard/docs/mobile-shell.md:3-10` |
| 5 | Praxis iPad Home Hub | Native SwiftUI app (iOS 17+), wall-mounted iPad Pro M2, Home Assistant plus Nexus client | Apartment wall | `/Volumes/Projects/Praxis iPad Home Hub/docs/architecture.md:15`; `PraxisHub/NexusClient.swift` exists |

Two consequences shape everything below. First, three of the five surfaces (Mac, Windows, Android) are webview shells around the same dashboard, so any feature built in the dashboard reaches them, but any feature that needs operating-system power has to be built natively in each shell. Second, the iPad hub is a separate Swift codebase and a separate Nexus project; work there is a cross-project change, not a dashboard change. The filing says "each app version" and does not authorize project-scope changes, so the iPad column is assessed but any iPad slice below is marked as needing Robert's scope call.

There is no iPhone app today. `app.json:12` sets `ios.supportsTablet` but no iOS build is evidenced; the iOS rows in Part A describe what an iPhone build would face, because "monitor my phone" might mean a future iPhone.

---

## Part A: Device protection

### A1. Four different things "detect and intercept hacking attempts" can mean

The request bundles four layers. They have very different feasibility, so later scoping should pick among them explicitly.

| Layer | Example threat | Who can actually see it |
|---|---|---|
| A. Attacks on Nexus itself | Someone hammering the Access login, a stolen service token, a forged operator JWT | **Nexus already can.** Cloudflare Access sees every request; `server/services/operator-access.js:16-19` logs every operator-auth refusal as a fixed category plus check name. |
| B. Device posture | Phone months behind on patches, Advanced Protection off, app tampered with, rooted device | Partly visible to an app through documented APIs (see A2). |
| C. Network traffic on the device | Phishing domains, malicious hosts contacted by other apps | Only through an OS-sanctioned network extension with explicit user consent; on iPhone/iPad only on supervised devices for full filtering (see A2). |
| D. OS compromise and spyware | Zero-click exploits, stalkerware, persistence | Not visible to an ordinary app on any platform. Only OS-vendor features (Android intrusion logging, Apple threat notifications, Lockdown Mode) or forensic tools see this layer. |

The honest headline: Nexus can genuinely **warn** about layer A and partly about B; it can **block** at layer C only by adopting an OS-sanctioned filter (preferably an existing managed one), and it cannot detect or intercept layer D on any platform. Promising "monitor my phone for hacking attempts and intercept" as a general capability would overstate what any non-OS app can do.

### A2. Per-platform capability

#### Android app (Nexus-Mobile-Android)

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
| Warn the user | Already possible: the app has `POST_NOTIFICATIONS` (`app.json:31`) and the Nexus push path. | Already granted | Verified locally |

#### iPhone (no app yet) and the iPad Home Hub

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| System-wide content filter (`NEFilterDataProvider`) | Only on supervised devices (or per-app via MDM). A consumer, unsupervised iPhone cannot run it; the Screen Time / Family Controls APIs are the sanctioned exception and are aimed at parental control, not threat detection. | Supervision + MDM profile | Sourced (Apple DTS answers, Apple developer forums) |
| Encrypted DNS settings (`NEDNSSettingsManager`) | An app can offer a DNS-over-HTTPS/TLS configuration (for example a filtering resolver); the user enables it in Settings. Blocks known-bad domains but does not inspect traffic. | User enables in Settings > VPN & Device Management > DNS | Platform knowledge |
| Packet tunnel VPN | Possible on unsupervised devices with user consent; one active VPN at a time. | VPN configuration consent | Platform knowledge |
| Detect spyware / OS compromise | Not available to apps. Apple's own threat notifications and Lockdown Mode are the OS-level answers; Nexus can only remind and link to them. No documented API was found that lets an app read whether Lockdown Mode is on. | User-controlled | Platform knowledge; Lockdown Mode API absence not confirmed |
| App integrity | App Attest / DeviceCheck attest that requests come from a genuine copy of the Nexus app. | None from user | Platform knowledge |
| iPad hub specifics | A wall-mounted shared device in a home: the realistic protection value is its own posture (passcode, Guided Access, OS updates) and protecting the Home Assistant and Nexus credentials it holds, not monitoring other devices. Supervision via Apple Configurator is possible for a dedicated device, which would unlock content filtering, but that is a device-management decision for Robert. | Supervision decision | Platform knowledge |

#### The Nexus.app (Mac)

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| System event monitoring | Endpoint Security framework: process, file and auth events system-wide. Requires an Apple-granted entitlement (`com.apple.developer.endpoint-security.client`), a system extension and Full Disk Access. | Apple entitlement request; user approval in System Settings | Platform knowledge |
| Network filtering | Network Extension content filter or DNS proxy as a system extension; unlike iOS, no supervision needed. | Developer ID signing, user approves the extension | Platform knowledge |
| Built-in protections | XProtect, Gatekeeper, FileVault, firewall status can be read and reported. | None or admin for some reads | Platform knowledge |
| Current app posture | The Tauri app requests only `core:default` IPC (`desktop/src-tauri/capabilities/default.json`) and only a microphone purpose string (`desktop/src-tauri/Info.plist:9`). Any protection feature would add new entitlements, signing requirements and permissions to an app that is deliberately minimal today. | n/a | Verified locally |

#### Windows travel shell

| Capability | What the platform allows | Consent / permission | Confidence |
|---|---|---|---|
| Antivirus / firewall state | Windows Security Center status can be queried (WMI `SecurityCenter2`). | None | Platform knowledge |
| Event monitoring | Windows event logs (failed sign-ins, Defender detections) are readable with appropriate rights; a driver-level filter (WFP) needs signing and admin. | Admin for many logs | Platform knowledge |
| Current app posture | Service-token session per device, pinned in `NEXUS_OPERATOR_DEVICE_IDS` (`server/services/operator-access.js:9-14`). Losing the laptop means losing that token, which makes "revoke this device" a real protection feature (A3 item 2). | n/a | Verified locally |

#### Browser dashboard

A web page cannot see the device's traffic, other tabs, or OS security state. Its protection role is limited to being the place where alerts and posture from the other layers are displayed.

### A3. What is realistically buildable, ranked by value per effort

These are candidates, not commitments.

1. **Nexus attack alerts (layer A).** Surface what Nexus already sees: bursts of Access denials, operator-auth refusals by check name (`operator-access.js` logs them without claims), service-token use from an unexpected device ID, sign-ins from a new country. Deliver as an actionable alert to every app version through the existing push and chat channels. Needs no device permission at all and is the only part of "incoming hacking attempts" Nexus can observe directly. Data source decision: Nexus server logs only, or also read-only Cloudflare Access request logs (a read-only analytics token is known to exist; using it is still "monitoring" and needs Robert's yes).
2. **Device inventory and revoke.** A cockpit list of the devices holding Nexus credentials (Android service token, Windows travel token, iPad hub credentials, Mac localhost), last-seen times, and a revoke path that rotates the Cloudflare service token. This is the practical "intercept" for a lost or compromised device: cut its access to Nexus.
3. **Device posture panel (layer B).** Each native shell reports a small, privacy-minimal posture record: OS version and security patch level, Advanced Protection on/off (Android), app integrity verdict (Play Integrity / App Attest), shell version versus latest. Nexus warns when posture degrades. Each shell needs its own native code and permission review.
4. **Guided OS protections (layers C and D).** Rather than building an interceptor, a checklist with deep links: Android Advanced Protection and intrusion logging, Private DNS with a filtering resolver, Apple Lockdown Mode, Safety Check, macOS firewall and FileVault, Windows Defender status. Optionally, the on-demand MVT (Mobile Verification Toolkit) scan procedure if Robert ever suspects spyware.
5. **Managed network filtering (layer C), only if Robert wants blocking.** Adopt an existing managed filter (for example Cloudflare Gateway DNS with the WARP client, since Nexus already runs on Cloudflare Access) instead of a home-built `VpnService`. A home-built interceptor would become a high-value target holding all of Robert's traffic, compete with other VPNs, and cost battery; a managed filter gives blocking plus logs Nexus could summarize. This is a configuration change on Robert's devices and account, so it needs Robert's explicit decision and is not authorized by this filing.

**Should not be promised:** detection of zero-click exploits or spyware by a Nexus app; interception of other apps' traffic on an unsupervised iPhone or iPad; reading SMS or other apps' notifications as a default feature; any automatic blocking action without Robert in the loop.

### A4. Risks specific to protection features

- Every permission added to a shell enlarges the attack surface of the app that holds Robert's Nexus credentials. The Mac app's deliberately minimal IPC (`capabilities/default.json`) is a feature worth keeping.
- Posture and network data are sensitive. Anything collected should stay on Robert's own Nexus server, have a retention limit, and never enter Praxis prompts by default.
- Alert fatigue: internet-facing hosts see constant background scanning; alerts need thresholds (layer A) or they will train Robert to ignore them.

---

## Part B: External displays

### B1. Connection methods and who owns the consent

| Method | Typical targets | Consent model | Can an app drive it? |
|---|---|---|---|
| Wired (USB-C / HDMI / Thunderbolt) | Monitors, TVs | Physical connection; OS shows the display | Yes: native apps can place a window or scene on the second display |
| AirPlay | Apple TV, AirPlay 2 TVs, Macs | User picks the receiver in the system picker | Mirroring is OS-only; apps can offer the AirPlay route picker and render a dedicated external scene |
| Google Cast | Chromecast, Google TV, Cast-enabled TVs | User picks in the Cast dialog | Yes, via Cast SDK (native) or Cast Web SDK / Presentation API in Chrome |
| Miracast | Many Windows-compatible TVs and dongles | Windows "Project" (Win+K) picker | OS-level; apps generally do not drive it |
| Sidecar / Universal Control | iPad as Mac display | User-initiated from macOS | OS-only |
| Open a URL on the display device | Smart-TV browsers, a spare laptop, a kiosk tablet | Whoever is at that device signs in | Nexus provides a view; the device must authenticate (see B4) |

In every case the operating system's picker (or the physical cable) is the consent step. Nexus should never connect to a display on its own; the follow-ups below only ever start from a user action.

### B2. Per-app-version capability

| App version | Practical display options | Notes | Confidence |
|---|---|---|---|
| Browser dashboard | Fullscreen API on any display; Window Management API (`getScreenDetails`) to open a view on a chosen second screen in Chromium browsers, behind a "window management" permission prompt; Presentation API to Cast devices from Chrome; Remote Playback API / AirPlay for media elements in Safari. | Window Management and Presentation are Chromium-only; Safari/WebKit does not implement them. Presentation and Remote Playback are W3C Second Screen specs, with the Open Screen protocol still a working draft. | Sourced (W3C TR pages, Chrome blog) for spec status; browser coverage is platform knowledge to re-check on MDN |
| The Nexus.app (Mac) | Native: Tauri can enumerate monitors and open a second window positioned on a chosen monitor; macOS mirroring and AirPlay to Apple TV are user-driven from Control Center. | WKWebView does not offer the Window Management or Presentation APIs, so a "present on second screen" feature has to be a small native Tauri command, not dashboard JavaScript. | Platform knowledge |
| Windows travel shell | Same Tauri multi-window approach; Win+K Miracast and wired displays are OS-driven. | Same native-command approach covers both Tauri personalities. | Platform knowledge |
| Android app | Android screen cast / mirroring from Quick Settings (OS-level, no app work); native Cast sender via Cast SDK in the shell; Android `Presentation` class for a wired or wireless secondary display; recent Android versions add connected-display desktop windowing on supported phones. | The dashboard runs inside `react-native-webview`; this research found no evidence that Android WebView exposes the Presentation API or Cast Web SDK, so casting a dashboard view would be native shell work. Treat WebView support as unconfirmed. | Platform knowledge; WebView gap unconfirmed |
| Praxis iPad Home Hub | iPad Pro M2 drives external displays over USB-C, supports Stage Manager extended display, and AirPlay. SwiftUI can declare an external-display scene so the hub shows a different view on the TV than on the wall. | The hub already declares a scene manifest (`PraxisHub/Info.plist:49`) and uses `UIScreen.main` for brightness (`PraxisHub/Managers/BatteryManager.swift:14`); no external-display scene exists today. Cross-project work. | Verified locally (current state); platform knowledge (capability) |

### B3. What content to present

The dashboard already has one display-oriented surface: Ambient Mode, a fullscreen overlay with the live core, clock, presence and latest stream event, holding a Screen Wake Lock so the display stays on (`dashboard/src/components/bridge/ambient-mode.tsx:1-9`, wake lock at `:68-70`). It is the natural starting point for "project what I need". Candidate presentable views, in rough order of usefulness:

1. Ambient bridge (exists) on a wall TV or spare monitor.
2. Current Focus / active work and the task board, read-only.
3. A single Document under review (Markdown, PDF, images, video) for walking through a deliverable on a big screen.
4. Calendar or day plan.

A presentation mode should default to a **presentation-safe** view: no inbox questions, credentials, private messages or email content, because external screens are often in shared rooms.

### B4. The one place the two areas meet: authenticating a display

A TV or Cast receiver cannot complete a Cloudflare Access one-time-PIN login, and the dashboard is behind Access. Any "open Nexus on that screen" path therefore needs a deliberate display credential: for example a short-lived, read-only, single-view token that Robert mints from a device where Robert is already signed in, scoped to the presentation-safe view and revocable from the device inventory (A3 item 2). Mirroring and wired displays avoid this entirely because the authenticated device renders the content. This is a security design decision, so it belongs in Part B scoping but must be reviewed against the Part A rules.

### B5. Recommended display approach

Start with what needs no new credentials: (1) a presentation-safe "Present" view in the dashboard, usable fullscreen on any wired or mirrored display; (2) a native "Open on second display" command in the Tauri app for the Mac and Windows shells. Add Cast from the Android shell, an iPad external-display scene, or token-based remote displays only after Robert says which physical displays Robert actually wants to use.

---

## 2. Decisions only Robert can make

These shape scope; none blocks this exploration.

1. **Phone.** Which phone is "my phone": the current Android device running the Nexus shell, or a future iPhone? The feasibility differs sharply (A2).
2. **Protection depth.** Warn-only (A3 items 1 to 4), or also block (item 5, a managed DNS/network filter that changes device configuration)?
3. **Data sources.** May Nexus read Cloudflare Access request logs for alerts, or only its own server logs?
4. **Displays.** Which real displays matter: a TV with Chromecast or Apple TV, a monitor on the Mac, the iPad hub driving a TV, a smart-TV browser?
5. **iPad scope.** Is the Praxis iPad Home Hub in scope for "each app version", given it is a separate project?

## 3. Candidate follow-up slices (not filed)

Kept in two separate lists, per the filing. Each would need its own task brief and acceptance criteria when Robert selects it.

**Device protection**
- P1. Nexus attack alerts from existing operator-auth refusals and Access denials, with thresholds, delivered to all apps. Acceptance: a synthetic burst of refused operator tokens in an isolated stack produces exactly one alert; normal traffic produces none.
- P2. Device inventory with last-seen and service-token revoke. Acceptance: revoking a device's token makes its next request fail and the cockpit shows it revoked.
- P3. Android posture report (patch level, Advanced Protection state) in the shell, opt-in. Acceptance: posture appears in the cockpit; no other data leaves the phone.
- P4. Guided protections checklist page with deep links per platform.
- P5 (needs Robert's explicit yes). Managed DNS/network filtering rollout and a Nexus summary of its block log.

**External displays**
- D1. Presentation-safe "Present" view (ambient, focus, board, single document) with fullscreen entry. Acceptance: no inbox, chat or credential content renders in the view.
- D2. Tauri "Open on second display" command for Mac and Windows shells. Acceptance: with two monitors, the view opens on the chosen monitor; with one, the command explains why it is unavailable.
- D3. Android Cast sender in the shell, or document the OS mirroring path if that suffices.
- D4 (needs iPad scope call). iPad hub external-display scene showing a chosen Nexus view on a connected TV.
- D5 (needs security review with Part A). Short-lived read-only display tokens for screens that cannot sign in.

## 4. Sources and limits

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

Limits of this research:

- No official developer.android.com page for the intrusion detection API was found; the `AdvancedProtectionManager` permission name comes from a secondary source.
- No source was found on whether an app can read Lockdown Mode state; treated as unavailable until confirmed.
- Current browser coverage of the Window Management, Presentation and Remote Playback APIs, and Android WebView's Presentation/Cast support, were not confirmed today; check MDN and Chrome Platform Status before scoping D1 to D3.
- Rows marked "platform knowledge" were not re-verified today and must be re-checked when their slice is scoped.
- No device, account, network or display was touched to produce this document.
