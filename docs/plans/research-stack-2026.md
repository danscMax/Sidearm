# Research: Stack Best Practices 2025-2026

## Summary

This document covers seven technology areas for the Naga Workflow Studio (Tauri v2 + React 19 + TypeScript 5.8 + Vite 7 + Vitest 4). The project is already at a modern baseline: React Compiler is enabled, hooks-plus-props architecture is used throughout, strict TypeScript is configured, and Vitest runs pure unit tests for lib functions. Key gaps are: no IPC-layer tests (mockIPC is not used), several valuable Tauri plugins are available but unused (global-shortcut, store, updater), React 19 hooks (useOptimistic, useActionState) could reduce boilerplate in a few spots, and Vite 7 offers Rolldown and Oxc but the current vite.config.ts opts into none of these yet. TypeScript 5.8's `--erasableSyntaxOnly` is not relevant here (no enums/namespaces used), but the return-type inference improvement is silently active. State management via hooks + props is still considered the correct choice at this scale.

---

## 1. React 19 Patterns

### Current State of the Project

- `useEffectEvent` is used extensively in `useRuntime.ts` for Tauri event listeners — this is the correct, idiomatic pattern.
- `startTransition` is applied consistently across all state updates from IPC results.
- `useMemo` is used manually in `App.tsx` for derived maps (`actionById`, `snippetById`, `bindingByControlId`, etc.).
- `useOptimistic` and `useActionState` are not used anywhere.
- `use()` hook is not used.
- React Compiler v1.0 (`babel-plugin-react-compiler`) is enabled via `vite.config.ts`.
- No Server Components anywhere (correct — not applicable to Tauri).

### What 2025-2026 Best Practices Recommend

**React Compiler v1.0 (stable since October 2025)**

The compiler automatically memoizes components, eliminating the need for manual `useMemo`, `useCallback`, and `React.memo`. It classifies every expression as Static, Reactive, or Derived, and memoizes granularly — including conditional memoization not achievable manually.

Implication for this project: the `useMemo` calls in `App.tsx` (e.g., `actionById`, `familySections`) are now redundant — the compiler handles them. However, the React team recommends leaving existing `useMemo` in place during adoption and only removing them once tested.

Source: [React Compiler v1.0 announcement](https://react.dev/blog/2025/10/07/react-compiler-1), [React Compiler introduction](https://react.dev/learn/react-compiler/introduction)

**useOptimistic**

Useful for UI actions where you want immediate visual response before Tauri IPC completes. The pattern: `const [optimisticState, addOptimistic] = useOptimistic(state, updateFn)`.

Concrete opportunity: the autostart toggle in `ServiceToolsPanel` (referenced in MEMORY) currently does a non-optimistic state update — this is where `useOptimistic` was explicitly noted as the right fix. When the user flips autostart, the UI waits for the Rust call before reflecting the change.

Source: [useOptimistic docs](https://react.dev/reference/react/useOptimistic), [Telerik guide to React 19 hooks](https://www.telerik.com/blogs/guide-new-hooks-react-19)

**useActionState**

Consolidates async action state (pending, result, error) into a single hook. Best fit for form-like flows: e.g., a "Run Action" button in RuntimePanel that has loading/success/error states.

Current pattern: manual `useState` for tracking results + try/catch in handler functions. `useActionState` would reduce this to a single declaration.

**use() hook + Suspense**

The `use()` hook reads a Promise in render, combined with a `<Suspense>` boundary. For Tauri, this means creating the IPC promise before render (e.g., on route or tab load) and passing it into a component that calls `use(promise)`.

Applicability: moderate. The current architecture loads config eagerly in a `useEffect` on mount. Migrating to `use()` + Suspense would make the loading state declarative but requires restructuring. For a single-window desktop app this is low priority.

**Server Components**

Not applicable. Tauri renders inside a local WebView — there is no server. No action needed.

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R1 | Audit `useMemo` calls in `App.tsx` with React Compiler DevTools — many may now be redundant | Small (audit only) |
| R2 | Apply `useOptimistic` to the autostart toggle in `ServiceToolsPanel` (was noted as non-optimistic in Audit Round 2) | Small |
| R3 | Consider `useActionState` for RuntimePanel's run/execute actions to consolidate pending+error state | Medium |
| R4 | Do NOT implement `use()` + Suspense for config loading — too much restructuring for marginal gain | Skip |

---

## 2. Tauri v2 Features

### Current State of the Project

**Plugins currently used** (from `Cargo.toml` and `package.json`):
- `tauri-plugin-dialog` — file open/save dialogs
- `tauri-plugin-window-state` — restores window size/position
- `tauri-plugin-autostart` — start with Windows

**Tauri features active** (from `tauri.conf.json`):
- `tray-icon` feature flag is set in Cargo.toml
- CSP is configured (`default-src 'self'`, etc.)
- Window min size: 900x600

**Capabilities** (from `src-tauri/capabilities/default.json`):
- `core:default`, `dialog:allow-open`, `dialog:allow-save`, `window-state:default`, `autostart:*`

### What 2025-2026 Best Practices Recommend

**Available but unused plugins worth considering:**

| Plugin | What it does | Applicability |
|---|---|---|
| `tauri-plugin-global-shortcut` | Register OS-level hotkeys (e.g., show/hide app, toggle runtime) | High — a mouse remapper app without global shortcuts is a gap |
| `tauri-plugin-store` | Persistent key-value store (JSON), more ergonomic than manual file R/W | Medium — could replace parts of config persistence |
| `tauri-plugin-updater` | In-app auto-update with signed binaries | Medium — needed before public release |
| `tauri-plugin-notification` | Native OS notifications | Low — useful for "runtime stopped unexpectedly" |
| `tauri-plugin-log` | Structured logging with configurable targets (file, stdout) | Low — currently uses `debugLogging` flag + custom debug log |
| `tauri-plugin-clipboard-manager` | Read/write clipboard | Already done in Rust natively; skip |
| `tauri-plugin-stronghold` | Encrypted secret storage via IOTA Stronghold | Not applicable — no secrets to store |

**Global Shortcut — highest priority:**
The app already intercepts keyboard events inside the window. But if the window is not focused (runtime is running in background), there is no way to trigger studio UI actions. `tauri-plugin-global-shortcut` registers OS-level shortcuts that fire even when the window is hidden.

Example: a global hotkey to show the window (from tray), or to toggle the runtime on/off without opening the UI.

Source: [Global Shortcut plugin docs](https://v2.tauri.app/plugin/global-shortcut/)

**Updater — needed before public release:**
The updater plugin provides cryptographically-signed auto-updates via a static JSON manifest (hostable on GitHub Releases). Signing keypair is generated with `tauri signer generate`. The private key must never be committed.

Architecture: `tauri.conf.json` sets `plugins.updater.pubkey`, the manifest JSON references artifact URLs. `tauri-action` (GitHub Actions) generates the manifest automatically.

Source: [Updater plugin docs](https://v2.tauri.app/plugin/updater/), [GitHub distribution guide](https://v2.tauri.app/distribute/pipelines/github/)

**Tray improvements — current gap:**
The `tray-icon` feature is compiled in, but the `minimizeToTray` setting exists in `AppConfig.Settings` — it is unclear whether the Rust side actually intercepts `WindowEvent::CloseRequested` to hide instead of close. The Tauri v2 pattern for minimize-to-tray is: handle `CloseRequested` → call `api.prevent_close()` → `window.hide()`.

Source: [System Tray docs](https://v2.tauri.app/learn/system-tray/), [Tauri discussion on close-to-tray](https://github.com/tauri-apps/tauri/discussions/2684)

**Permissions model:**
The current `default.json` capability file only grants the minimum required. This is correct. The Tauri team recommends: "only give necessary capabilities to each window" and "defer business logic to Core." The project already follows this — all IPC is custom Rust commands, no filesystem plugin exposure.

Source: [Capabilities docs](https://v2.tauri.app/security/capabilities/)

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R5 | Add `tauri-plugin-global-shortcut` — register a hotkey (e.g., `Ctrl+Alt+N`) to show/hide the studio window | Medium |
| R6 | Verify `minimizeToTray` is actually implemented in Rust — if not, add `CloseRequested` handler | Small (audit) |
| R7 | Add `tauri-plugin-updater` + GitHub Actions pipeline when preparing for distribution | Medium |
| R8 | Consider `tauri-plugin-notification` for critical runtime failures (non-blocking user feedback) | Small |
| R9 | Skip Stronghold, Store, Log plugins — current approach is sufficient | Skip |

---

## 3. Vite 7

### Current State of the Project

`vite.config.ts` uses `@vitejs/plugin-react` v5 with Babel plugin for React Compiler. No explicit `build.target`. Port 45173 fixed. HMR configured for `TAURI_DEV_HOST`. Watch ignores `src-tauri/`.

`package.json`: `"vite": "^7.0.4"`, `"@vitejs/plugin-react": "^5.1.4"`, `"vitest": "^4.0.18"`

### What 2025-2026 Best Practices Recommend

**Vite 7 key changes (released 2025):**

1. **Node.js 20.19+ / 22.12+ required** — v18 EOL April 2025, Vite 7 drops it. No action needed unless on old Node.
2. **New default browser target: `baseline-widely-available`** — previously `modules`. This is a breaking change for the `build.target` default. For a Tauri desktop app using a fixed WebView version this matters less, but the default shift means older Chromium targets are no longer the floor.
3. **Oxc replaces esbuild for transforms** — automatic, no config change needed. Vite still accepts `esbuild` config but converts to Oxc internally.
4. **Rolldown (experimental)** — A Rust-based bundler replacing Rollup/esbuild for builds. Not yet stable; opt-in only via `experiments.rolldownBuild: true`. GitLab reports 100x peak memory reduction. For this project (small app), the gain is negligible but worth tracking.
5. **Removed: Sass legacy API, `splitVendorChunkPlugin`** — not used in this project.
6. **`@vitejs/plugin-react` v5** — already in use. Uses Oxc for JSX transformation (faster than Babel transforms), but Babel is still invoked for React Compiler plugin. This is the correct and expected setup.

**Vite 7 + Vitest 4 compatibility:** Vitest 4.0 was released December 2025 with stable Browser Mode, visual regression (`toMatchScreenshot`), Playwright traces. This project uses Vitest 4.0.18.

Source: [Vite 7 announcement](https://vite.dev/blog/announcing-vite7), [Vite 7 changes overview](https://syntackle.com/blog/vite-7-is-here/), [OpenReplay Vite 7 guide](https://blog.openreplay.com/whats-new-vite-7-rust-baseline-beyond/)

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R10 | Explicitly set `build.target: "chrome110"` (or whichever WebView2 version ships with the target Windows) to avoid ambiguity with the new `baseline-widely-available` default | Tiny |
| R11 | Track Rolldown stability — when it exits experimental, it will benefit large build pipelines; no action needed now | Watch |
| R12 | No other Vite 7 migration work needed — project was already on Vite 7.0.4 | Done |

---

## 4. TypeScript 5.8

### Current State of the Project

`tsconfig.json` has `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `moduleDetection: force`. TypeScript version: `~5.8.3`.

No TypeScript enums are used (discriminated unions throughout). No namespaces. No `import =`. The type system is clean.

### What 2025-2026 Best Practices Recommend

**TypeScript 5.8 features (released March 2025):**

1. **Granular branch checking in return expressions** — conditional expressions in `return` statements now have each branch checked separately against the declared return type. This catches bugs previously missed. **Silently active** — no opt-in needed. Some functions in `useRuntime.ts` and `useAppPersistence.ts` may benefit from stricter checking.

2. **`--erasableSyntaxOnly`** — prevents use of enums, namespaces, parameter properties. The project already uses none of these, so this flag would pass cleanly. Useful if you ever want Node.js type-stripping compatibility. Low priority for a Tauri app (frontend is Vite-compiled anyway).

3. **`require()` of ESM modules (Node.js interop)** — only relevant for Node.js backend scenarios. Not applicable to this Tauri/Vite frontend.

4. **`--libReplacement false`** — disables lookup for `@typescript/lib-*` packages. Not needed unless performance profiling shows TypeScript startup is slow (unlikely).

5. **Program load optimizations** — path normalization and options re-validation skip. Silently active. Large projects with many files benefit most.

**TypeScript 5.4 features** (already available, worth verifying use):
- `NoInfer<T>` utility type — blocks type inference on a specific generic parameter. Useful in generic functions where you want the caller to be explicit. Not currently used in the codebase; examine generic function signatures in `config-editing.ts`.
- `satisfies` operator (TS 4.9) — already part of the language. Could be used for config shape validation at compile time.

Source: [TS 5.8 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/), [InfoQ TS 5.8 overview](https://www.infoq.com/news/2025/03/typescript-58-released/), [erasableSyntaxOnly explainer](https://www.totaltypescript.com/erasable-syntax-only)

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R13 | Add `"erasableSyntaxOnly": true` to tsconfig — project uses no enums/namespaces, so this will pass cleanly and future-proof the codebase | Tiny |
| R14 | Review generic function signatures in `config-editing.ts` for `NoInfer<T>` opportunities (prevents callers from accidentally narrowing via inference) | Small |
| R15 | No other TS 5.8 migration needed — granular branch checking is already active and the project's strict mode will surface any new errors | Done |

---

## 5. Testing

### Current State of the Project

**What is tested:**
- `src/lib/config-editing.test.ts` — pure functions for config mutations (upsertBinding, createProfile, etc.)
- `src/lib/verification-session.test.ts` — pure verification session state machines
- `src/lib/action-helpers.test.ts`, `menu-helpers.test.ts`, `verification-helpers.test.ts`, `helpers.test.ts`, `labels.test.ts`

**`vitest.config.ts`**: minimal config, no browser mode, runs in Node/jsdom by default.

**What is NOT tested:**
- Any hook (`useRuntime`, `useAppPersistence`, `useVerification`, `useActionPicker`)
- Any Tauri IPC interaction (`backend.ts` functions)
- Any component rendering
- Tauri event listeners

**Test stack:** Vitest 4.0.18, no `@testing-library/react`, no `@tauri-apps/api/mocks`.

### What 2025-2026 Best Practices Recommend

**Vitest 4.0 (stable browser mode, December 2025):**
- Stable Browser Mode: tests run in a real Playwright/WebdriverIO browser, not jsdom
- Visual regression via `toMatchScreenshot`
- Playwright traces support for debugging
- `toBeInViewport` matcher

Source: [Vitest 4.0 announcement](https://vitest.dev/blog/vitest-4), [Vitest 4.0 InfoQ coverage](https://www.infoq.com/news/2025/12/vitest-4-browser-mode/)

**Tauri IPC mocking (`@tauri-apps/api/mocks`):**

The official approach uses `mockIPC` from `@tauri-apps/api/mocks` to intercept all `invoke()` calls without a real backend:

```typescript
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

beforeEach(() => {
  mockIPC((cmd, args) => {
    if (cmd === "start_runtime") return { status: "running" };
    if (cmd === "get_debug_log") return [];
  });
});

afterEach(() => clearMocks());
```

For events, use `{ shouldMockEvents: true }` to intercept `listen()` and `emit()`.

This enables testing `useRuntime`, `useAppPersistence` as hooks in isolation using `renderHook` from `@testing-library/react`.

Source: [Tauri v2 mocking docs](https://v2.tauri.app/develop/tests/mocking/), [Vitest hook testing guide](https://mayashavin.com/articles/test-react-hooks-with-vitest)

**Testing philosophy for a Tauri desktop app:**

- **Unit tests for pure lib functions** — the project already does this well. Keep expanding.
- **Hook tests with mockIPC** — highest gap. `useAppPersistence` (with 500ms auto-save, undo/redo) and `useRuntime` (with 8 concurrent Tauri event listeners) are complex enough to warrant integration-style hook tests.
- **Component tests** — lower priority for a tool-centric desktop app with no public API surface. The UI is stable enough that snapshot testing could become a maintenance burden.
- **Avoid browser mode for now** — the project's UI is not publicly accessible (desktop only), visual regression testing is overkill. Browser mode adds setup complexity (Playwright dependency) with low ROI.

**Recommended test structure for hooks:**
```typescript
// src/hooks/useAppPersistence.test.ts
import { renderHook, act } from "@testing-library/react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { useAppPersistence } from "./useAppPersistence";

beforeEach(() => {
  mockIPC((cmd) => {
    if (cmd === "load_config") return { config: minimalConfig, warnings: [], path: "test.json", createdDefault: false };
    if (cmd === "save_config") return { config: minimalConfig, warnings: [], path: "test.json" };
  });
});
afterEach(() => clearMocks());

test("refreshConfig sets viewState to ready on success", async () => {
  const { result } = renderHook(() => useAppPersistence());
  await act(() => result.current.refreshConfig());
  expect(result.current.viewState).toBe("ready");
});
```

**Dependencies to add:**
- `@testing-library/react` — `renderHook`, `act`
- `@tauri-apps/api` already installed; `@tauri-apps/api/mocks` is part of it, no new dep needed

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R16 | Add `@testing-library/react` as dev dependency | Tiny |
| R17 | Add `src/hooks/useAppPersistence.test.ts` — test refreshConfig, updateDraft, undo/redo, auto-save timing | Medium |
| R18 | Add `src/hooks/useRuntime.test.ts` — mock all 8 IPC listeners, test state transitions on events | Medium |
| R19 | Add `src/lib/backend.test.ts` — test `normalizeCommandError` edge cases (already unit-testable, no IPC needed) | Small |
| R20 | Skip browser mode / visual regression for now — low ROI for a desktop tool app | Skip |

---

## 6. State Management

### Current State of the Project

The project uses three custom hooks (`useAppPersistence`, `useRuntime`, `useVerification`) composed in `App.tsx`, with all state threaded down as props. No Context API, no Zustand, no Redux. Data flow is strictly unidirectional.

The `App.tsx` file is ~647 lines after the decomposition refactor. Prop signatures for child components like `DebugWorkspace` and `ProfilesWorkspace` are substantial (10–20 props each).

### What 2025-2026 Best Practices Recommend

**Hooks + props is still the recommended baseline** for apps of this scale (50 files) when state is domain-separated and data flow is unidirectional. The key reference from tkdodo (one of the most cited React state experts in 2025-2026): Zustand is best introduced when you have genuine global shared state, not just deep prop drilling.

The current architecture passes `updateDraft` and `setConfirmModal` down through multiple levels. This is the primary warning sign — when setter functions are passed 3+ levels deep, Context or a store is worth considering.

**2025-2026 consensus on when to add Zustand:**
- You have 3+ levels of prop drilling for the same value
- Sibling components need to share state that their parent doesn't own
- You need state that persists across component unmounts

For this app: the config state is owned at the App level and passed down once (to direct children like Sidebar, ProfilesWorkspace, DebugWorkspace). That's 2 levels — not deep enough to justify Zustand today.

Source: [Zustand + React Context (tkdodo)](https://tkdodo.eu/blog/zustand-and-react-context), [Working with Zustand (tkdodo)](https://tkdodo.eu/blog/working-with-zustand), [Zustand vs useState (freeCodeCamp)](https://www.freecodecamp.org/news/zustand-vs-usestate-how-to-manage-state-in-react/)

**If the app grows:**
If more workspaces are added (M3 DRY extraction is planned), prop interfaces will widen. At that point, a `useAppState()` Context hook (not a Context Consumer) or a small Zustand store for UI-level state (`selectedProfileId`, `selectedControlId`, `workspaceMode`) would be appropriate.

**Current risk areas:**
- `App.tsx` passes `setConfirmModal` to Sidebar and ProfilesWorkspace — this is a setter function passed 2 levels deep for modal triggers. A Context with `openConfirmModal(config)` would be cleaner.
- `updateDraft` is threaded through 4+ components — acceptable because it's the core mutation primitive.

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R21 | Keep current hooks + props architecture — no migration to Zustand needed at current scale | Done |
| R22 | When M3 DRY extraction happens, consider a `ModalContext` (or `useModal()` hook via Context) to eliminate `setConfirmModal` prop drilling | Medium (deferred) |
| R23 | If a 4th workspace is added, extract `selectedProfileId` / `selectedControlId` / `workspaceMode` to a lightweight Context — 3 lines of useState in context, no Zustand needed | Medium (deferred) |

---

## 7. Desktop App UX Patterns

### Current State of the Project

**What the app does well:**
- `Ctrl+Z/Y`, `Ctrl+K` (command palette) — keyboard-first navigation
- Arrow keys for hotspot navigation
- Number keys 1–4 for workspace switching
- `useEffectEvent` for keyboard handler (correct — no stale closure issues)
- Focus trap handling (noted in Audit Round 2 for modals)
- `aria-selected`, `aria-live` regions (noted as fixed in Audit Round 2)
- `prefers-reduced-motion` CSS support (noted as fixed)
- `minimizeToTray` setting in config schema

**Known gaps (from `tauri.conf.json` and Rust Cargo.toml):**
- Tray icon feature flag is set (`features = ["tray-icon"]`) but actual "minimize to tray on close" behavior needs Rust-side `CloseRequested` interception
- No global OS-level hotkey (app must be focused for keyboard shortcuts to work)
- No updater — distribution not yet wired up
- Window title is "Naga Workflow Studio" (static) — the audit noted dynamic window titles as an improvement

### What 2025-2026 Best Practices Recommend

**Windows app guidelines 2025-2026** (Microsoft Learn):
- Provide keyboard access to all features — the project satisfies this for in-window navigation.
- System tray presence for long-running/background apps — relevant since the runtime can run without the window.
- Global hotkey for show/hide — considered a baseline expectation for system-tray apps.
- Context menus on right-click — not implemented; potentially useful on mouse button hotspots.

**Polish bar for a desktop utility app in 2026:**
1. System tray with context menu (Show, Toggle Runtime, Quit) — the user expects this for a background-running tool
2. Global shortcut to show the window when runtime is active in background
3. Native OS notifications for critical errors (runtime crash) — non-blocking
4. Window title reflecting current state (e.g., "Naga Workflow Studio — Profile: Gaming")
5. Installer / auto-update flow — essential before sharing with others
6. Keyboard shortcut discoverability — tooltip hints, command palette already exists (good)

Source: [Microsoft Windows app best practices](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices), [ToDesktop cross-platform UX guide](https://www.todesktop.com/blog/posts/designing-desktop-apps-cross-platform-ux), [Tauri System Tray docs](https://v2.tauri.app/learn/system-tray/)

**Accessibility checklist for 2026:**
- All interactive elements reachable by Tab/Enter — verify ActionPickerModal and ContextMenu
- Color contrast WCAG 2.1 AA — not audited in this research
- Screen reader: role attributes on custom controls (mouse hotspots use click handlers — check if `role="button"` + `tabIndex` are set)
- `aria-live` regions for status updates (runtime started/stopped) — noted as fixed in Audit Round 2

### Recommendations

| # | Recommendation | Effort |
|---|---|---|
| R24 | Implement system tray context menu (Show, Toggle Runtime, Quit) in Rust using existing `tray-icon` feature | Medium |
| R25 | Verify and complete "minimize to tray on close" (`CloseRequested` handler in Rust) — `minimizeToTray` is in config schema but may not be connected | Small (audit + fix) |
| R26 | Add `tauri-plugin-global-shortcut` for a system-level "show window" hotkey (configurable, default e.g. `Ctrl+Alt+N`) | Medium |
| R27 | Add tray icon right-click menu that exposes runtime toggle and quit — avoids needing the window open for basic control | Medium |
| R28 | Audit mouse hotspot `MouseVisualizationSvg.tsx` for `role="button"` + `tabIndex={0}` on interactive elements | Small |

---

## Risks & Considerations

1. **React Compiler vs manual useMemo**: If you remove `useMemo` calls in `App.tsx` based on the compiler, verify with React DevTools that the compiler is actually optimizing those components (look for the `_c()` calls in compiled output). If the compiler bails on a component due to a rules violation, removing `useMemo` would regress performance silently.

2. **mockIPC in Vitest**: `@tauri-apps/api/mocks` requires `window.__TAURI_INTERNALS__` to exist. In Vitest's jsdom environment, you may need to add `Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {} })` in a setup file. Without this, `mockIPC` will fail silently or throw.

3. **Global shortcuts on Windows**: `tauri-plugin-global-shortcut` can conflict with other apps' registered shortcuts. Always check if registration succeeded and handle gracefully if not.

4. **Vite 7 `baseline-widely-available` target**: WebView2 (used by Tauri on Windows) tracks Chromium closely but the exact version depends on the user's installed version. Setting an explicit `build.target` prevents surprise breakage when the default shifts.

5. **TypeScript `erasableSyntaxOnly`**: Adding this flag is safe for the current codebase. Future contributors may try to add `const enum` or decorators — this flag will correctly block them.

6. **Updater key management**: When adding the updater plugin, the private signing key must never be committed to git. Use environment variables in CI only. Losing the key means existing installs cannot receive updates.

---

## Sources

- [React v19 release blog](https://react.dev/blog/2024/12/05/react-19)
- [React Compiler v1.0 release](https://react.dev/blog/2025/10/07/react-compiler-1)
- [React Compiler introduction](https://react.dev/learn/react-compiler/introduction)
- [useOptimistic docs](https://react.dev/reference/react/useOptimistic)
- [Telerik guide to React 19 hooks](https://www.telerik.com/blogs/guide-new-hooks-react-19)
- [Vite 7 announcement](https://vite.dev/blog/announcing-vite7)
- [Vite 7 changes overview](https://syntackle.com/blog/vite-7-is-here/)
- [What's new in Vite 7 (OpenReplay)](https://blog.openreplay.com/whats-new-vite-7-rust-baseline-beyond/)
- [TypeScript 5.8 release announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/)
- [TypeScript 5.8 on InfoQ](https://www.infoq.com/news/2025/03/typescript-58-released/)
- [erasableSyntaxOnly explainer (Total TypeScript)](https://www.totaltypescript.com/erasable-syntax-only)
- [TypeScript 5.8 docs](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html)
- [Tauri v2 Plugin catalog](https://v2.tauri.app/plugin/)
- [Tauri v2 Global Shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/)
- [Tauri v2 Updater plugin](https://v2.tauri.app/plugin/updater/)
- [Tauri v2 System Tray](https://v2.tauri.app/learn/system-tray/)
- [Tauri v2 Capabilities and permissions](https://v2.tauri.app/security/capabilities/)
- [Tauri v2 IPC mocking docs](https://v2.tauri.app/develop/tests/mocking/)
- [Vitest 4.0 announcement](https://vitest.dev/blog/vitest-4)
- [Vitest 4.0 InfoQ coverage](https://www.infoq.com/news/2025/12/vitest-4-browser-mode/)
- [Zustand vs useState (freeCodeCamp)](https://www.freecodecamp.org/news/zustand-vs-usestate-how-to-manage-state-in-react/)
- [Working with Zustand (tkdodo)](https://tkdodo.eu/blog/working-with-zustand)
- [Zustand and React Context (tkdodo)](https://tkdodo.eu/blog/zustand-and-react-context)
- [Microsoft Windows app best practices](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices)
- [ToDesktop cross-platform desktop UX guide](https://www.todesktop.com/blog/posts/designing-desktop-apps-cross-platform-ux)
