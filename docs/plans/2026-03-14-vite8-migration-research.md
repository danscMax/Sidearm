# Research: Vite 8 Migration Path

## Summary

Vite 8.0 was released March 12, 2026. Its headline change is replacing both esbuild (dev transform) and Rollup (production bundler) with a single Rust-based bundler called Rolldown, plus Oxc for JavaScript/TypeScript transforms. The result is 10–30x faster builds with a broad backward-compatibility shim. For this project the migration has one significant code change: the React Compiler can no longer be fed through `plugin-react`'s Babel option — it must move to a separate `@rolldown/plugin-babel` plugin using the new `reactCompilerPreset` helper. Everything else in the current config translates automatically. Vitest 4.1 (already in use) explicitly supports Vite 8 via its updated peer dependency range `^6.0.0 || ^7.0.0 || ^8.0.0-0`. Tauri v2's Vite integration is purely configuration-level (server port, host, watch ignore) and is unaffected by the bundler change.

---

## Current Stack (locked)

| Package | Current | Target |
|---|---|---|
| `vite` | 7.3.1 | 8.x |
| `@vitejs/plugin-react` | 5.1.4 | 6.x |
| `babel-plugin-react-compiler` | 1.0.0 | keep |
| `vitest` | 4.0.18 → 4.1.x | 4.1.x (no change to major) |
| `typescript` | 5.8.3 | unchanged |

---

## Existing Code Analysis

### Relevant Files

- `vite.config.ts` — Defines Vite config, imports `@vitejs/plugin-react`, configures React Compiler via `babel.plugins`. The `build.target: "chrome110"` and the TAURI_DEV_HOST / HMR block are all inert to the Rolldown migration.
- `vitest.config.ts` — Minimal: `jsdom` environment, test glob, setup file. No rollup/esbuild options so zero changes needed.
- `tsconfig.json` — `target: ES2022`, `moduleResolution: bundler`, `verbatimModuleSyntax`. All remain valid.
- `package.json` — The only `devDependencies` touching the build pipeline are `vite`, `@vitejs/plugin-react`, `babel-plugin-react-compiler`, and `vitest`.

### Patterns Found

The only Vite-internal API in `vite.config.ts` is `defineConfig` and the plugin array — no direct use of rollup/esbuild internals, no `manualChunks`, no `transformWithEsbuild`. This project is a minimal config, which means the automatic compatibility shim handles almost everything.

---

## Breaking Changes: Vite 7 → Vite 8

### 1. Bundler replacement (Rolldown + Oxc)

- esbuild and Rollup are **removed**. Rolldown handles both dev-server optimisation and production bundling.
- `build.rollupOptions` is renamed `build.rolldownOptions`. Old name is auto-converted with a deprecation warning — no hard break.
- `optimizeDeps.esbuildOptions` auto-converted to `optimizeDeps.rolldownOptions` (deprecated, will be removed in future).
- `esbuild` config key deprecated; use `oxc` instead.
- **Impact on this project:** None. The project uses none of these options directly.

### 2. JavaScript / TypeScript transform

- Oxc replaces esbuild for JS/TS transforms.
- **Decorator lowering removed** — Oxc does not support it. Babel or SWC workaround required. This project has no decorators.
- `transformWithEsbuild` utility removed; plugins that called it must migrate to `transformWithOxc`. No plugins in this project use it directly.

### 3. CSS minification

- Lightning CSS replaces esbuild for CSS minification. To restore esbuild, set `build.cssMinify: 'esbuild'` and install esbuild as an explicit dev dependency.
- **Impact:** Cosmetic difference in output. No action needed unless exact byte-output reproducibility is required.

### 4. Default browser target raised

Chrome 107→111, Edge 107→111, Firefox 104→114, Safari 16.0→16.4. The project explicitly sets `build.target: "chrome110"`, which is below the new default but still valid to specify. **No change needed** — explicit target overrides the default.

### 5. CommonJS interop

Default import behaviour from CJS modules is now consistent between dev and build. If a runtime `Cannot read properties of undefined` appears after upgrade, add `legacy: { inconsistentCjsInterop: true }` as a temporary shim. This project has no direct CJS dependencies.

### 6. Output format removals

`'system'` and `'amd'` output formats removed. Not used here.

### 7. Plugin API (affects third-party plugins only)

- `load` / `transform` hooks that convert non-JS content must return `moduleType: 'js'`. Affects plugin authors, not consumers.
- Deprecated hooks: `shouldTransformCachedModule`, `resolveImportMeta`, `renderDynamicImport`, `resolveFileUrl`.
- `build()` throws `BundleError` (wraps an `errors` array) instead of a raw error.

### 8. `import.meta.hot.accept()` URL form removed

Must use module IDs, not URLs. HMR code in this project passes no URLs to `accept()`.

### 9. Node.js minimum version

Node 20.19+ or 22.12+ — same as Vite 7. No change.

---

## Question-by-Question Answers

### Q1: Breaking changes for this project specifically

Three items are real breaks; the rest auto-migrate:

| Break | Severity | Action |
|---|---|---|
| `babel.plugins` in `plugin-react` removed | **High** | Move to `@rolldown/plugin-babel` + `reactCompilerPreset` |
| `@vitejs/plugin-react` v5 → v6 (Vite 7 dropped) | **Medium** | Version bump |
| esbuild no longer bundled | Low | No direct usage here |

### Q2: @vitejs/plugin-react version for Vite 8

**Use v6.** Plugin-react v6 was released alongside Vite 8 and requires Vite 8+. Plugin-react v5 technically still works with Vite 8 (the team noted v5 remains compatible for staggered upgrades), but v5 still depends on `transformWithEsbuild` internally — updating to v6 is the clean path and avoids the esbuild removal warning.

### Q3: React Compiler integration in plugin-react v6 — Babel dropped

**Babel is no longer a dependency of plugin-react.** Vite 8 / Oxc handles React Refresh natively, removing the need for Babel for that transform. However, `babel-plugin-react-compiler` itself still requires Babel to run.

**New setup:**

```bash
npm install @rolldown/plugin-babel
# babel-plugin-react-compiler stays, no version change needed
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export default defineConfig(async () => ({
  plugins: [
    react(),                                   // no babel option anymore
    babel({ presets: [reactCompilerPreset()] }),
  ],
  // ... rest unchanged
}));
```

`reactCompilerPreset` accepts the same options as the old `ReactCompilerConfig` object (e.g. `compilationMode: 'annotation'`, `target: '19'`). Since the current `ReactCompilerConfig` is `{}` (all defaults), the migration is a direct swap.

### Q4: Vitest 4 with Vite 8

**Vitest 4.1 supports Vite 8 — no major version bump required.**

Vitest 4.1.0 (released March 12, 2026, same day as Vite 8) updated its peer dependency to:

```
"vite": "^6.0.0 || ^7.0.0 || ^8.0.0-0"
```

The current project has `vitest: ^4.0.18`. Upgrading to `^4.1.0` is sufficient. Vitest 5 is in planning/discussion and is not yet released — there is no need to wait for it.

**Action:** `npm install vitest@^4.1.0` (patch update, no API changes expected).

A known issue during the beta period — `"Both esbuild and oxc options were set"` warning in Vitest — was resolved before the stable Vite 8 release.

### Q5: Tauri v2 compatibility with Vite 8

**No compatibility issues found.** Tauri v2's Vite integration is purely configuration-level:

- It reads `devUrl` and `frontendDist` from `tauri.conf.json`.
- The Vite config additions (TAURI_DEV_HOST, strictPort, HMR block, watch.ignored) are server options that are unrelated to the bundler.
- `@tauri-apps/cli` spawns `vite` / `vite build` as a subprocess — it does not import Vite APIs.
- No open Tauri GitHub issues found specifically blocking Vite 8.

The existing `vite.config.ts` Tauri block is fully forward-compatible.

### Q6: Migration checklist

See below.

---

## Migration Checklist

```
[ ] 1. Install updated packages
        npm install vite@^8.0.0 @vitejs/plugin-react@^6.0.0 @rolldown/plugin-babel vitest@^4.1.0

[ ] 2. Update vite.config.ts
        - Remove babel option from react()
        - Add: import babel from "@rolldown/plugin-babel"
        - Add: import react, { reactCompilerPreset } from "@vitejs/plugin-react"
        - Add babel({ presets: [reactCompilerPreset()] }) to plugins array

[ ] 3. Run the dev server
        cargo tauri dev
        — Confirm React Compiler is active (look for compiled component output or
          test with a "use no memo" annotation to verify the compiler fires)

[ ] 4. Run tests
        npm test
        — Vitest 4.1 should pick up Vite 8 with no config changes

[ ] 5. Run production build
        vite build
        — Check for warnings about deprecated options (esbuildOptions, etc.)
        — Measure build time delta (should be significantly faster)

[ ] 6. Smoke test the Tauri window
        — Confirm HMR still works in dev
        — Confirm the packaged app loads correctly

[ ] 7. Optional: remove babel-plugin-react-compiler from root if no other usages
        (it is still needed as a transitive dep of reactCompilerPreset)
```

---

## Risks and Considerations

- **React Compiler config migration is the only real code change.** The old `babel.plugins` array approach is a hard breaking change in plugin-react v6 — it will fail silently or error if left in place.
- **`@rolldown/plugin-babel` is a new package** in the Rolldown ecosystem; its stability should be verified (it is officially maintained by VoidZero/the Vite team, not a community fork).
- **`build.target: "chrome110"` is below Vite 8's new default** (chrome111). Keeping the explicit override maintains the current target. Removing it would raise the minimum to chrome111 — acceptable since Tauri uses Chromium, not a web browser.
- **Lightning CSS minification** may produce marginally different CSS output (whitespace, shorthand expansion). Run a visual diff of production CSS if exact reproducibility matters.
- **Yarn classic (v1.x) has issues** parsing the `||` peer dependency syntax in Vitest 4.1. This project uses npm so it is unaffected.
- **Gradual migration path available:** Switch to the `rolldown-vite` npm alias package on Vite 7 first to isolate Rolldown-specific issues before committing to Vite 8. Given how minimal this config is, a direct jump to Vite 8 should be safe.
- **No Vitest 5 needed:** The Vitest team confirmed Vite 8 support lands in Vitest 4.1, not a major version bump.

---

## Recommendations

1. **Do the migration as a single PR.** The total change surface is small: `package.json` bumps plus a 4-line `vite.config.ts` rewrite. There is no benefit to staging it.
2. **Use `npm install` with exact versions first** (`vite@8.0.0 @vitejs/plugin-react@6.0.0`) to pin, then relax to `^` ranges once smoke-tested.
3. **Keep `babel-plugin-react-compiler` in devDependencies** even though it is no longer referenced in `vite.config.ts` directly — `reactCompilerPreset` depends on it under the hood.
4. **Check for the `rollupOptions` deprecation warning** in build output — it is informational only but confirms the auto-conversion path is active. Optionally rename to `rolldownOptions` to future-proof.
5. **Defer TypeScript target upgrade** — `ES2022` remains fully supported; no change required.

---

## Sources

- [Migration from v7 | Vite (official)](https://vite.dev/guide/migration)
- [Vite 8.0 is out! | Vite blog](https://vite.dev/blog/announcing-vite8)
- [Vite 8 Beta: The Rolldown-powered Vite](https://vite.dev/blog/announcing-vite8-beta)
- [plugin-react v6.0.0 Release Notes](https://github.com/vitejs/vite-plugin-react/releases/tag/plugin-react@6.0.0)
- [vite-plugin-react README (main branch)](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md)
- [Vitest 5 discussion (confirms Vite 8 in Vitest 4.1)](https://github.com/vitest-dev/vitest/discussions/9664)
- [Vitest yarn 1.x peer dep issue (reveals peerDep range)](https://github.com/vitest-dev/vitest/issues/9859)
- [Vitest 4.0 release post](https://vitest.dev/blog/vitest-4)
- [Tauri v2 Vite setup documentation](https://v2.tauri.app/start/frontend/vite/)
- [Vite 8 Rolldown migration guide | byteiota](https://byteiota.com/vite-8-0-rolldown-migration-guide-10-30x-faster-builds/)
- [What's New in ViteLand: February 2026 | VoidZero](https://voidzero.dev/posts/whats-new-feb-2026)
