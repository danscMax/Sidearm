# Research: Competitor Mouse Remapping Software — 2025-2026

**Date:** 2026-03-14
**Scope:** Competitor analysis for Naga Workflow Studio (Tauri v2 desktop app, Razer Naga V2 HyperSpeed, 36-button surface)

---

## Summary

The competitor landscape for mouse remapping software in 2025-2026 is divided into two camps: heavyweight OEM apps (Synapse 4, G HUB) that are bloated and cloud-dependent, and lightweight tools (X-Mouse Button Control, AutoHotkey, reWASD) that are powerful but require technical skill. Naga Workflow Studio occupies a differentiated middle ground — device-specific, offline-first, with a strong verification workflow. The highest-impact missing features relative to competitors are: live macro recording (capture keys in real time), button chording (two-button combos), an on-screen display (OSD) for active profile, and a richer gesture/swipe system. The most structurally important differentiator to protect is the explicit verification workflow, which no competitor offers.

---

## Direct Competitor Analysis

### 1. Razer Synapse 4

**What it does:**
- Button remapping to keyboard keys, mouse functions, media keys, launch
- Hypershift (secondary layer while Hypershift button held)
- Macro editor: manual keypress/delay entry + on-the-fly recording via dedicated keyboard button
- App-specific profiles with auto-switching by executable
- Cloud sync of profiles/macros via Razer ID (note: as of Feb 2026, Synapse 3 cloud is shutting down)
- On-board memory: Naga V2 HyperSpeed has only 1 on-board slot — macros do NOT store to on-board memory in Synapse 4 (regression from Synapse 3)
- Profile import/export (local + cloud)
- DPI staging, polling rate, lighting (Chroma RGB)

**Pain points reported by users (2024-2025):**
- Built on Chromium/web tech — 40% CPU usage at idle reported, up to 3.5 GB RAM in Synapse 3
- Synapse 4 described as "buggy mess" — fails to auto-switch profiles, resets to default mid-game
- Sends data to Razer servers; device config requires online server contact
- On-the-fly macro recording is keyboard-only, not available during in-game play reliably
- No offline-only mode; features degrade without Razer ID
- Cannot run without Synapse running in background for remapping to work
- Input stuttering attributed to Synapse 4 in game forums
- Community has created tools (SynapseKiller) to strip Synapse and still keep configs

**What Naga Workflow Studio has that Synapse lacks:**
- Fully offline, no telemetry, no account required
- Explicit hardware signal verification workflow (unique)
- Lightweight native binary (Tauri/Rust), no Chromium
- Dry-run execution mode for testing without real hardware
- Russian-first UI designed for a specific power-user audience
- Sequence/macro delay step control without workarounds

**What Synapse has that Naga Workflow Studio lacks:**
- Live macro recording (real-time keystroke capture)
- On-the-fly macro recording hotkey
- DPI configuration / polling rate / lighting
- Profile community sharing (limited but present)
- Cloud sync / cross-machine roaming

---

### 2. Logitech G HUB

**What it does:**
- Full button remapping on visual device map (click hotspot → assign)
- Macro system with: manual entry, real-time recording, loops, delays, conditional Lua scripting
- Lua scripting engine: `OnEvent()` callbacks, `IsMouseButtonPressed()`, conditional logic, variables, loops — full programmability
- Profile auto-switching by detected game (game library from Epic, GOG, Steam, WeGame scanned)
- Cloud sync via Logitech account — exact settings roam to another machine on login
- Community profile sharing — download profiles from pros/streamers, share your own
- "G HUB Games" (introduced 2025): organized game library + associated profiles
- Profile duplication across apps
- SmartShift (for MX Master series): context-aware scroll speed
- Mouse gesture support (MX series): hold button + swipe direction → different actions

**Features that Naga Workflow Studio lacks vs G HUB:**
- **Lua scripting** — full conditional logic per button (huge power-user differentiator for G HUB)
- **Community profile sharing** — discover, download, share profiles (social layer)
- **Cloud profile roaming** — open on any machine, profiles are there
- **Mouse gestures** — hold button, swipe direction → distinct action (4 directional gestures × buttons)
- **Real-time macro recording** — click record, type, done; then edit delays
- **Game library integration** — scan installed games, auto-link profiles

**G HUB weaknesses:**
- Also Electron-based, known to be resource-heavy
- Profile storage path confusing, manual migration between Windows accounts requires workaround
- Cloud sync reliability complaints in community

---

### 3. SteelSeries GG / Engine

**What it does:**
- Button remapping, macros (record in-game or in app, then edit delays)
- App-specific profiles
- **Cloud sync** (a flagship feature — described as "stores profiles, access across devices seamlessly")
- GameSense: RGB lighting tied to in-game events
- Sonar Audio: spatial audio, EQ presets, AI noise cancellation
- Moments: gameplay clip recording/editing/sharing
- Export/import profiles

**Notable feature — Moments capture:** SteelSeries bundles gameplay capture directly into their suite, which treats the mouse as part of a broader workflow hub (not just remapping). This framing of "peripheral as workflow center" is directionally interesting.

---

### 4. X-Mouse Button Control (XMBC)

**What it does:**
- Per-application and per-window profiles — auto-activates as mouse moves over window (not just focus)
- Up to 10 configurable **layers** per profile, hot-key switchable
- **Button chording** — hold one button while clicking another → different action
- **Time-dependent actions** — action changes based on how long button is held (tap vs hold vs long-hold)
- Simulated keystrokes editor (full key sequences)
- Application launch, clipboard operations, screen capture, media controls
- Virtual Desktop support (Windows 10/11)
- **Hover-based profile trigger** — activates when mouse is over the window, not just when window has focus
- No scripting language but covers most common power-user patterns through composition
- Free, lightweight, no account required

**Features Naga Workflow Studio lacks vs XMBC:**
- **Button chording** — two mouse buttons held simultaneously → different action
- **10 layers per profile** (vs 2: standard + hypershift)
- **Hover-based profile switching** (vs focus-based / exe matching)
- **Time-dependent actions** — tap vs hold vs long-hold with different outcomes per threshold
- **Layer hot-key switching** — cycle or jump to a numbered layer via key

---

### 5. AutoHotkey (AHK)

**What it does:**
- Free, open-source Windows scripting language
- Full conditional logic: `#IfWinActive`, variables, loops, functions, file I/O
- Context-aware remapping (active window, window title, process name)
- Mouse button + modifier chord combos natively
- Thousands of community scripts
- No GUI — pure scripting

**Power user draw:** AHK is the ceiling of flexibility. Users who graduate from Synapse/G HUB go to AHK when they need logic the GUIs can't express. The question for Naga Workflow Studio is whether it can offer enough built-in conditional logic to serve these users without requiring scripting.

**Key concept applicable to Naga Workflow Studio:**
- Conditional actions: `if active window title contains X, do Y` — this is a widely-desired power-user feature that no GUI tool does well
- AHK's `#IfWinActive` / `#IfWinExist` is the gold standard mental model users have

---

### 6. reWASD

**What it does:**
- Remap mouse buttons + controller buttons + keyboard keys across device types
- App-focused configs: enable config only when chosen app is in focus
- Single, Long, Double, Triple, Start, Release — 6 trigger modes per button
- Turbo mode (auto-fire), macro sequences with pauses and rumble (controller)
- Paid software (subscription/perpetual)
- Version 9.1.1 (April 2025)
- Horizontal scroll remapping added in v9.0

**Notable feature:** 6 trigger modes per physical control (tap, hold, double, triple, on-press, on-release). This gives extreme action density per button without adding buttons.

Naga Workflow Studio currently has: press, doublePress, triplePress, hold (4 modes, per `TriggerMode` type in `src/lib/config.ts`) — already competitive here.

---

## Power User Pain Points (Community Research)

Based on forum analysis (Razer Insider, Overclock.net, community search):

1. **Synapse always running** — Users hate that remapping stops working if Synapse is closed. They want persistent on-board config that works without software.

2. **Macro recording is unreliable** — Synapse 4 macro recording loses key values mid-recording, and doesn't work reliably during in-game play.

3. **Profile auto-switch is broken in Synapse 4** — The most commonly cited functional regression. Profiles switch back to default randomly.

4. **Telemetry and cloud dependency** — Power users resent that a local peripheral requires an internet-connected account to function fully.

5. **Resource usage** — Chromium-based software consuming 40% CPU at idle is a showstopper for users who care about game performance.

6. **MMO/productivity users want more layers** — 12-button thumb grid users often want application-specific button sets for 5-8 different apps. The "one profile per app" model works but users want faster switching.

7. **Chording is desired** — Users on forums explicitly request "hold button A + press button B = new action" — currently only XMBC delivers this in a GUI.

8. **No OSD / feedback loop** — Users don't know which profile is active without opening the app. An OSD toast or tray notification on profile switch is highly requested.

9. **Gesture support for thumb-heavy mice** — Logitech MX series has this; Naga users see the feature and want it for their 12-button grid.

10. **Text expansion as a first-class feature** — Many MMO/productivity users use the thumb grid exclusively for text snippets / command expansion. This use case deserves dedicated UX, not just a "text snippet" action type.

---

## Missing Features Analysis

Each feature is rated: **Impact** (High/Med/Low), **Effort** (High/Med/Low), **Differentiator vs Table Stakes**.

### Feature 1: Live Macro Recording (real-time keystroke capture)

**What it is:** User clicks "Record", types keys in real-time, clicks "Stop". Delays are captured automatically. User can then edit the timing.

**Competitors with it:** Synapse 4, G HUB, SteelSeries GG

**Current state in Naga Workflow Studio:** Sequences are built manually (add step, set key, set delay).

**Impact:** High — This is the #1 expected feature for any macro tool. Its absence is a first-impression blocker for new users comparing to Synapse.

**Effort:** Medium — Requires a recording state machine in Rust (capture keyboard hook events with timestamps → translate to sequence steps → present for editing). Frontend state change is minimal.

**Differentiator vs Table Stakes:** Table stakes. Every direct competitor has it.

**Recommendation:** Implement. This is the single highest-priority missing feature.

---

### Feature 2: Button Chording (simultaneous two-button combos)

**What it is:** Hold Button A while pressing Button B → fire a different action than either button alone.

**Competitors with it:** X-Mouse Button Control, AutoHotkey, JoyShockMapper

**Current state:** Not implemented. Actions are 1:1 per button per layer.

**Impact:** High — For 12-button thumb grids this effectively multiplies the action space (12 × 12 = 144 potential combos). Power users specifically request this.

**Effort:** High — Low-level hook must detect second keydown while first is still held, within a configurable timing window. Ambiguity: should the primary button fire on press, or wait to see if a chord follows? Requires a "chord resolution timer" (~80ms typical). Edge cases with triple presses and hold actions interacting.

**Differentiator vs Table Stakes:** Differentiator — only XMBC among GUI tools supports this. None of the OEM apps do it.

**Recommendation:** Implement in a future phase. Design the data model to accommodate chords (a chord is a `Binding` with two `ControlId`s as the trigger). Start with "hold modifier button + press action button" model (simpler than true simultaneous detection).

---

### Feature 3: On-Screen Display (OSD) for Active Profile

**What it is:** When the active profile changes (app focus changes, manual switch), a brief toast or overlay shows the profile name. Similar to audio device notifications in Windows.

**Competitors with it:** None directly — but users on community forums widely request it. G HUB shows a tray notification. Synapse has no feedback.

**Current state:** Profile switches happen silently. The app shows state only when open.

**Impact:** High — Reduces the most common user anxiety ("is the right profile active?"). This is especially important given Synapse 4's broken profile-switching being a top complaint.

**Effort:** Low — Tauri v2 supports OS-level notifications via `tauri-plugin-notification`. A small Rust-side event (profile switched) triggers a Windows toast notification. Alternatively, a minimal always-on-top tray popup.

**Differentiator vs Table Stakes:** Differentiator — no OEM app does this well. This turns an invisible background process into a transparent one.

**Recommendation:** Implement. This is the highest-impact, lowest-effort feature on the list.

---

### Feature 4: Profile Import/Export (JSON file)

**What it is:** Export a profile (with all its bindings, actions, sequences) to a shareable file. Import from file.

**Competitors with it:** Synapse (local + cloud), G HUB (local + community), SteelSeries GG

**Current state in Naga Workflow Studio:** Partially — the config schema is versioned JSON (v2), and atomic save/backup exists. Full profile-level export/import UI may not be complete (backlog item).

**Impact:** High — Enables users to back up, share, and recover profiles. Also enables a future community sharing layer.

**Effort:** Low — Config is already JSON. A Rust command to read/write a profile sub-tree to a named file. Frontend dialog for file selection (Tauri `dialog` plugin).

**Differentiator vs Table Stakes:** Table stakes for any serious tool.

**Recommendation:** Implement if not already done. This is foundational for user trust.

---

### Feature 5: Conditional Actions / Window-Title-Aware Triggers

**What it is:** An action is fired only if the active window title matches a pattern (regex or substring). Example: Button 7 → `Ctrl+C` normally, but if window title contains "vim" → `yy`.

**Competitors with it:** AutoHotkey (via `#IfWinActive`), XMBC (hover-based profile switching is related but coarser), reWASD (app-focus config enabling)

**Current state:** App mappings target by exe + title filter at the profile level. But within a profile, there is no conditional branching at action execution time.

**Impact:** Medium — Power users (developers, vim/emacs users, tool-switchers) would love this. But it adds cognitive complexity to the UI.

**Effort:** High — Requires extending the action data model to include a `condition` field, a UI for editing conditions, and Rust runtime evaluation against the active window title at trigger time.

**Differentiator vs Table Stakes:** Differentiator — no OEM GUI app does in-action conditions. AHK is the only tool with this, but it requires scripting.

**Recommendation:** Design the data model extension now (add optional `condition` to `Action` or `Binding`), implement basic window-title substring matching as Phase 2.

---

### Feature 6: Cloud Sync / Cross-Machine Roaming

**What it is:** Profiles and settings stored in a cloud backend, accessible after login on any machine.

**Competitors with it:** Synapse (Razer ID), G HUB (Logitech account), SteelSeries GG

**Current state:** Local-only (which is a design choice and competitive advantage for privacy).

**Impact:** Medium — Important for users who switch between machines. But Razer Naga V2 HyperSpeed is primarily a desktop device; multi-machine use is less common than for laptops.

**Effort:** Very High — Requires auth system, backend infrastructure, sync conflict resolution, privacy policy, and ongoing maintenance.

**Differentiator vs Table Stakes:** This is a table-stakes feature for OEM apps, but it can be framed as an intentional non-feature ("your data stays on your machine"). The privacy framing resonates with the target audience that dislikes Synapse's telemetry.

**Recommendation:** Do not implement. Lean into "offline-first, zero telemetry" as a differentiator. Offer local backup/export as the alternative.

---

### Feature 7: Per-Game Profile Auto-Detection (Game Library Scan)

**What it is:** Software scans installed game libraries (Steam, Epic, GOG) and offers to create profiles for detected games with suggested icons and names.

**Competitors with it:** G HUB (introduced "G HUB Games" in 2025), limited in others.

**Current state:** App mappings use exe path + title filter. User manually creates profile and sets matching rules.

**Impact:** Medium — Quality-of-life improvement for gamers. Reduces setup friction for game profiles.

**Effort:** Medium — Requires reading Steam/Epic/GOG library manifests (well-known file paths on Windows). Provide a list of detected games for user to choose which to create profiles for.

**Differentiator vs Table Stakes:** Table stakes for gaming-focused tools.

**Recommendation:** Low priority for now given the productivity/MMO focus. Add to backlog as a Phase 3 feature if user feedback confirms gaming is a primary use case.

---

### Feature 8: Multi-Device Support

**What it is:** Configure multiple physical devices simultaneously (e.g., Naga + a keyboard + a second mouse).

**Competitors with it:** G HUB, Synapse (all Razer devices), SteelSeries GG (all SS devices)

**Current state:** Single-device app, hard-coded to Naga V2 HyperSpeed device model.

**Impact:** Low (for current audience) — The app is intentionally single-device. Supporting multiple Razer Naga variants would be higher value than cross-brand multi-device support.

**Effort:** High — Requires device catalog abstraction, UI for device selection, per-device config trees.

**Differentiator vs Table Stakes:** Table stakes for OEM apps, but single-device focus is a valid design choice for a focused tool.

**Recommendation:** Consider adding support for Naga V2 Pro and Naga Pro as future variants (same family, similar button layout). Cross-brand support is out of scope.

---

### Feature 9: Button Usage Statistics / Heatmap

**What it is:** Track how often each button is pressed per profile/app, visualize as a heatmap on the mouse diagram.

**Competitors with it:** WhatPulse (standalone tool), InputScope (open-source). No mainstream OEM app has this.

**Current state:** Not implemented.

**Impact:** Medium for power users — Helps users discover which buttons they actually use vs. which they configured but never trigger. Useful for layout optimization.

**Effort:** Medium — Rust-side event counter per ControlId per profile, persisted to a local stats file. Frontend overlays count labels on mouse diagram hotspots.

**Differentiator vs Table Stakes:** Strong differentiator — no OEM remapping app has this. Unique value for power users who want to optimize layouts.

**Recommendation:** Implement as a later feature. The mouse diagram is already the central visual — overlaying usage counts is a natural extension. Start with session counts (per runtime session), optionally persist across sessions.

---

### Feature 10: Gesture Support (Hold + Swipe Direction)

**What it is:** Hold a designated button and move the mouse in one of 4 directions (up/down/left/right) to trigger a different action. Popularized by Logitech MX Master series.

**Competitors with it:** Logitech G HUB (MX series gesture button), some browser mouse gesture extensions.

**Current state:** Not implemented.

**Impact:** Low-Medium — Useful for productivity mice; less natural on a thumb-grid mouse where buttons are the primary modality.

**Effort:** High — Requires mouse movement tracking during button hold, direction classification, and a gesture state machine. Interaction conflicts with normal click detection.

**Differentiator vs Table Stakes:** Table stakes for MX-class mice; not expected on Naga.

**Recommendation:** Skip. The 12-button thumb grid is a more direct solution to the same problem (discrete actions without gesture ambiguity). Gestures on a Naga would compete awkwardly with the grid.

---

### Feature 11: Lua / Scripting Engine

**What it is:** Embed a scripting runtime (Lua, Rhai, WASM) allowing users to write conditional logic, state variables, loops, and complex action sequences beyond what the GUI offers.

**Competitors with it:** G HUB (Lua with `OnEvent()` callbacks), AutoHotkey (standalone)

**Current state:** Not implemented. Sequences cover ordered steps but no branching.

**Impact:** Medium for advanced users — the "power ceiling" feature. Without it, advanced users hit a wall and go to AHK.

**Effort:** Very High — Embedding Lua (via `rlua`/`mlua` crate in Rust) or Rhai (Rust-native scripting) requires sandboxing, an API surface design, an editor with syntax highlighting, error reporting, and debugging.

**Differentiator vs Table Stakes:** Differentiator — most OEM apps don't have scripting. G HUB has it but it is poorly documented and limited.

**Recommendation:** Deferred. If implementing, prefer **Rhai** (Rust-native, no C FFI, designed for embedding). The better near-term approach is expanding the action model with conditional actions (Feature 5) to cover 80% of scripting use cases without requiring users to learn a scripting language.

---

### Feature 12: OBS / Streaming Integration

**What it is:** Buttons on the Naga trigger OBS scene switches, mute/unmute, start/stop recording. Mouse as a streaming control surface.

**Competitors with it:** G HUB (OBS plugin), Elgato Stream Deck ecosystem

**Current state:** Launch action can open any app/URL, which could indirectly trigger OBS via hotkeys. No native integration.

**Impact:** Medium for streaming audience — but this appears to be a secondary audience for the Naga V2 HyperSpeed specifically (it targets MMO/productivity).

**Effort:** Medium — OBS has a WebSocket API (v5) that can be called from Rust. Implement as an `ExternalTrigger` action type.

**Differentiator vs Table Stakes:** Differentiator if done well. The streaming community is large and underserved by current tools.

**Recommendation:** Low priority now, but add to backlog. The `launch` action type can be extended to `externalApi` in the future.

---

## UI/UX Patterns from Competitors

### Visual Device Editor (all OEM apps)
All major tools use a photorealistic or schematic image of the device with clickable hotspots. Naga Workflow Studio already implements this. The differentiator is how much information is shown on the hotspot vs. in a side panel. G HUB uses minimal hotspot labels and expands detail on selection — this is the right pattern and aligns with current implementation.

### Drag-and-Drop Action Assignment (G HUB)
G HUB allows dragging a macro from a library panel onto a button hotspot. This is faster than the modal picker flow for repeated assignments. Current Naga Workflow Studio uses a modal action picker. Drag-and-drop would reduce friction for power users assigning many buttons at once.
- **Impact:** Medium | **Effort:** Medium | **Type:** UX improvement

### Quick-Assign Inline Picker (XMBC)
XMBC shows a dropdown directly on the button entry in a list — no modal. Fast for users who know what they want.
- The command palette in Naga Workflow Studio partially serves this role.

### Layer Indicator in Always-Visible Status (all tools)
Every competitor shows the currently active layer/profile in a persistent status area. In tools with OSD, this extends to the screen. The verification workflow in Naga Workflow Studio already surfaces active profile/layer — this should also be visible from the main tray/taskbar icon.

### Context Menu on Right-Click Hotspot (G HUB, Synapse)
Right-clicking a button hotspot in the visual editor shows: "Clear", "Copy to Hypershift layer", "Assign macro", etc. Reduces navigation for common operations.
- **Impact:** Medium | **Effort:** Low | **Type:** UX improvement

---

## Competitive Positioning Summary

| Feature | Synapse 4 | G HUB | XMBC | Naga WS | Gap Type |
|---|---|---|---|---|---|
| Offline / no account | No | No | Yes | Yes | Differentiator (keep) |
| Hardware verification | No | No | No | Yes | Major differentiator |
| Visual device editor | Yes | Yes | No | Yes | Table stakes (done) |
| App-specific profiles | Yes | Yes | Yes | Yes | Table stakes (done) |
| Hypershift layer | Yes (Razer only) | No | No | Yes | Table stakes (done) |
| Live macro recording | Yes | Yes | No | **No** | Table stakes (missing) |
| Button chording | No | No | Yes | **No** | Differentiator (missing) |
| OSD active profile | Partial | Tray only | No | **No** | Differentiator (missing) |
| Cloud sync | Yes | Yes | No | No | Table stakes (intentional skip) |
| Profile export/import | Yes | Yes | No | Partial | Table stakes (finish) |
| Lua scripting | No | Yes | No | No | Differentiator (deferred) |
| Mouse gestures | No | Yes (MX) | No | No | Low priority |
| Usage heatmap | No | No | No | No | Differentiator (opportunity) |
| Community profiles | Limited | Yes | No | No | Nice-to-have |
| Conditional actions | No | Lua only | Profile-level | Profile-level | Differentiator (design now) |
| Trigger modes (tap/hold/etc.) | 2 | 2 | 2 | 4 | Advantage (keep) |
| Lightweight native binary | No | No | Yes | Yes | Differentiator (keep) |

---

## Risks and Considerations

1. **Feature creep vs. focus** — The competitive advantage of Naga Workflow Studio is focus and quality, not feature parity. Adding every competitor feature would recreate Synapse. Prioritize features that reinforce the verification and explicit-mapping workflows.

2. **Live macro recording complexity** — Capturing keystrokes in a low-level hook during recording must not interfere with the running runtime. The recording mode needs to coexist safely with the hotkey interception layer. The Rust runtime state machine must handle "recording" as a distinct mode.

3. **Button chording timing sensitivity** — The chord resolution window (~80ms) must be tunable. Too short and chords are missed; too long and there is a perceptible input delay on every single-button press while the system waits for a potential second button. This is a UX/feel challenge, not just an implementation challenge.

4. **OSD implementation on Windows** — Tauri v2 notification plugin produces standard Windows toast notifications which may not appear over full-screen games. A small always-on-top borderless window may be needed for the full-screen case. This adds complexity.

5. **Privacy stance must be explicit** — Users migrating from Synapse will ask "does this phone home?". The offline-first stance is a marketing advantage but must be stated clearly in the app's about screen and documentation.

6. **Synapse 3 sunset (Feb 2026)** — Razer is forcing migration to Synapse 4. Many users dislike Synapse 4 enough to seek alternatives. This is an adoption opportunity window in early 2026.

---

## Prioritized Recommendations

### Phase 1 (High impact, lower effort — do next)

1. **OSD / tray notification on profile switch** — Impact: High | Effort: Low | Differentiator
   - Use `tauri-plugin-notification` for a Windows toast when active profile changes
   - Add profile name to tray icon tooltip

2. **Complete profile import/export UI** — Impact: High | Effort: Low | Table stakes
   - JSON export of a single profile subtree to file
   - Import with schema validation and conflict resolution (rename on collision)

3. **Live macro recording** — Impact: High | Effort: Medium | Table stakes
   - Add "Record" mode to sequence editor
   - Rust-side: keyboard hook captures events with timestamps during recording session
   - Frontend: "Recording..." state with Stop button, preview of captured steps, post-record edit

### Phase 2 (Medium impact, medium effort — plan for after Phase 1)

4. **Button chording** — Impact: High | Effort: High | Differentiator
   - Data model: `ChordBinding { primaryControlId, secondaryControlId, action }`
   - Runtime: chord resolution timer in hook callback
   - UI: chord assignment in action picker ("hold + press" picker)

5. **Button usage statistics (session heatmap)** — Impact: Medium | Effort: Medium | Differentiator
   - Track press count per ControlId per session in Rust
   - Overlay count labels on hotspots in visual editor
   - Optional: persist across sessions to a local stats file

6. **Conditional action conditions (window title match)** — Impact: Medium | Effort: High | Differentiator
   - Extend `Binding` with optional `condition: { windowTitleContains: string }` field
   - Runtime evaluates condition at trigger time before firing action
   - UI: simple "only when window title contains..." text field on binding editor

### Phase 3 (Lower priority / longer term)

7. **Drag-and-drop action assignment** — UX improvement; plan after visual editor is finalized
8. **Right-click context menu on hotspots** — UX improvement; "Clear", "Copy to Hypershift", "Assign"
9. **Rhai scripting engine** — Power ceiling feature; design API surface before implementing
10. **Multiple Naga variant support** — Expand device catalog to Naga V2 Pro / Naga Pro

### Intentional non-features (keep out)
- Cloud sync — privacy differentiator, replace with export/import
- Cross-brand multi-device — out of scope for focused tool
- RGB lighting — Synapse is better at this; do not compete
- OBS/streaming native integration — low priority for current audience
- Gesture support (swipe) — thumb grid makes gestures redundant on this device

---

## Sources

- [Razer Synapse 4 — Official Page](https://www.razer.com/synapse-4)
- [How to remap Razer Naga V2 buttons](https://mysupport.razer.com/app/answers/detail/a_id/6400/~/how-to-remap-keys-or-buttons-on-your-razer-naga-v2-mouse)
- [Synapse 4 is awful — Razer Insider thread](https://insider.razer.com/razer-synapse-4-55/synapse-4-is-awful-and-it-makes-me-want-to-completely-leave-the-razer-ecosystem-82676)
- [Synapse 4 somehow got even worse — Razer Insider](https://insider.razer.com/razer-synapse-4-55/synapse-4-somehow-got-even-worse-72352)
- [Synapse 4 is still a buggy mess — Razer Insider](https://insider.razer.com/razer-synapse-4-55/synapse-4-is-still-a-buggy-mess-68555)
- [Razer Synapse is an abomination — Overclock.net](https://www.overclock.net/threads/razer-synapse-is-an-abomination.1797680/)
- [SynapseKiller — GitHub](https://github.com/NxRoot/SynapseKiller)
- [Naga V2 HyperSpeed — Onboard Memory issues — Razer Insider](https://insider.razer.com/mice-and-surfaces-9/on-board-memory-naga-v2-hyperspeed-44849)
- [Logitech G HUB — Official](https://www.logitechg.com/en-us/software/ghub)
- [Logitech G HUB Games — 2025 announcement](https://www.logitech.com/blog/2025/09/17/personalized-gaming-perfectly-organized-introducing-logitech-g-hub-games/)
- [G HUB Lua API Reference](https://studylib.net/doc/26182349/g-series-lua-api)
- [G HUB Lua Cheatsheet — GitHub](https://github.com/jehillert/logitech-ghub-lua-cheatsheet)
- [SteelSeries GG — Official](https://steelseries.com/gg/engine)
- [SteelSeries GG Guide — Forgeary](https://forgeary.com/steelseries-gg/)
- [X-Mouse Button Control — Official](https://www.highrez.co.uk/downloads/xmousebuttoncontrol.htm)
- [XMBC — Button Chording forum](https://forums.highrez.co.uk/viewtopic.php?t=2353)
- [AutoHotkey v2 — Remapping docs](https://www.autohotkey.com/docs/v2/misc/Remap.htm)
- [reWASD — Mouse remapping](https://www.rewasd.com/how-to-remap-mouse-buttons-with-rewasd)
- [reWASD — Advanced features](https://help.rewasd.com/installation-notes/basic-and-advanced-features.html)
- [WhatPulse — Input statistics and heatmaps](https://whatpulse.org)
- [InputScope — Mouse/keyboard heatmap — GitHub](https://github.com/suurjaak/InputScope)
- [Logitech Mouse Gesture Guide](https://www.logitech.com/en-us/discover/a/mouse-gestures-setup)
- [Razer Synapse alternatives — AlternativeTo](https://alternativeto.net/software/razer-synapse/)
- [Mouse Button Remapper roundup 2025 — WhatSoftware](https://whatsoftware.com/changing-and-customizing-your-mouse-buttons-actions/)
- [Best MMO mice 2025 — RTINGS](https://www.rtings.com/mouse/reviews/best/mmo)
