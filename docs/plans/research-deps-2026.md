# Dependency Audit — Naga Workflow Studio
Date: 2026-03-14
Auditor: Supply Chain Auditor (Claude)

## Summary

- **2 Medium** findings
- **3 Low** findings
- **0 Critical / 0 High**

Lock files exist and are committed for both JS (`package-lock.json` v3) and Rust (`Cargo.lock` v4). No floating wildcards reach production at runtime.

---

## Dependency Table

### JavaScript / npm (frontend + build tooling)

| Package | Manifest spec | Locked version | Latest | Status | Action needed |
|---|---|---|---|---|---|
| `@tauri-apps/api` | `^2` | 2.10.1 | 2.10.1 | Up to date | None |
| `@tauri-apps/plugin-autostart` | `^2.5.1` | 2.5.1 | 2.5.1 | Up to date | None |
| `@tauri-apps/plugin-dialog` | `^2` | 2.6.0 | 2.6.0 | Up to date | None |
| `@tauri-apps/cli` | `^2` | 2.10.1 | 2.10.1 | Up to date | None |
| `react` | `^19.1.0` | 19.2.4 | 19.2.4 | Up to date | None — RSC CVEs (Dec 2025) don't apply to Tauri desktop apps |
| `react-dom` | `^19.1.0` | 19.2.4 | 19.2.4 | Up to date | None |
| `@types/react` | `^19.1.8` | 19.1.8 | 19.1.8 | Up to date | None |
| `@types/react-dom` | `^19.1.6` | 19.1.6 | 19.1.6 | Up to date | None |
| `vite` | `^7.0.4` | 7.3.1 | 8.x (Vite 8 released 2026-03-12) | **Vite 8 available** | Low priority upgrade; 7.3.1 is secure, contains fix for CVE-2025-58752 (fixed in 7.0.7+). Vite 8 brings Rolldown/Oxc internals and ~10-30x faster builds. Upgrade path exists but requires testing. |
| `@vitejs/plugin-react` | `^5.1.4` | 5.1.4 | 6.0.1 | Major update available | Low priority; v6 drops Babel as a peer dependency (Babel no longer needed for Oxc transforms). Upgrade tied to Vite 8 migration. |
| `babel-plugin-react-compiler` | `^1.0.0` | 1.0.0 | 1.0.0 | Up to date | Note: with `@vitejs/plugin-react` v6, Babel is no longer a first-class dependency — compiler integration changes |
| `typescript` | `~5.8.3` | 5.8.3 | 5.9.x | Minor update available | Low: `~` pin prevents auto-update to 5.9. No security issues. Upgrade to 5.9 for latest language features at own pace. |
| `vitest` | `^4.0.18` | 4.0.18 | 4.1.0 | Patch behind | Low: `^` allows auto-update on next install. Run `npm update vitest`. |

### Rust / Cargo (backend)

| Package | Manifest spec | Locked version | Latest | Status | Action needed |
|---|---|---|---|---|---|
| `tauri` | `2` | 2.10.3 | 2.10.3 | Up to date | None |
| `tauri-build` | `2` | (resolved) | current | Up to date | None |
| `tauri-plugin-dialog` | `2` | (resolved) | current | Up to date | None |
| `tauri-plugin-window-state` | `2` | (resolved) | current | Up to date | None |
| `tauri-plugin-autostart` | `2` | 2.5.1 | 2.5.1 | Up to date | None |
| `serde` | `1` | 1.0.228 | 1.0.228 | Up to date | None |
| `serde_json` | `1` | 1.0.149 | 1.0.149 | Up to date | None |
| `jsonschema` | `0.44.1` | 0.44.1 | ~0.44.x | Pinned, appears current | Exact pin is fine; verify with `cargo update -p jsonschema` |
| `tempfile` | `3` | 3.26.0 | current 3.x | Up to date | None |
| `thiserror` | `2` | 2.0.18 | 2.0.18 | Up to date | None |
| `png` | `0.17` | 0.17.16 | 0.17.x | Up to date — no active CVEs | None |
| `base64` | `0.22` | 0.22.1 | 0.22.1 | Up to date | None |
| `regex` | `1` | 1.12.3 | 1.12.x | Up to date | None — CVE-2022-24713 was fixed in 1.5.5; current version is safe |
| `windows-sys` | `0.61` | 0.61.2 | 0.61.2 | Up to date | None |
| `bytes` (transitive) | — | 1.11.1 | 1.11.1 | **Patched** | RUSTSEC-2026-0007 / CVE-2026-25541 fixed in 1.11.1 — current lock is already safe |

---

## Findings

---

### SC-001
**File:** `package.json`

**Dефект:** `typescript` is pinned with `~5.8.3` which blocks automatic uptake of TypeScript 5.9, now released as the current stable minor.

**Packages:** `typescript`

**CVE:** None

**Рекомендация:** Update manifest to `~5.9.x` (or `^5.9.0`) when ready; TypeScript 5.9 has no breaking changes for this project's configuration. Not urgent.

**Уверенность:** deterministic

**Severity:** Low

---

### SC-002
**File:** `package.json`

**Дефект:** `vite` is constrained to `^7.x`; Vite 8.0 (released 2026-03-12) is now the latest major and uses Rolldown + Oxc internally for significantly faster builds. The project's `^7.0.4` range will never auto-resolve to v8.

**Packages:** `vite`, `@vitejs/plugin-react`

**CVE:** CVE-2025-58752 (Vite path traversal affecting dev server exposed to network, fixed in 7.0.7) — **not applicable** to current locked version 7.3.1.

**Рекомендация:** Plan a Vite 8 + `@vitejs/plugin-react` v6 migration. At v6, Babel is dropped as a required peer, changing how `babel-plugin-react-compiler` integrates (moves to `@rolldown/plugin-babel`). Keep at v7 until a dedicated upgrade spike. Severity is informational; current stack is secure.

**Уверенность:** deterministic

**Severity:** Low

---

### SC-003
**File:** `package.json`

**Дефект:** `vitest` is behind by one patch (`4.0.18` installed vs `4.1.0` latest). The `^4.0.18` range allows `npm update` to resolve it automatically.

**Packages:** `vitest`

**CVE:** None known

**Рекомендация:** Run `npm update vitest` to pick up 4.1.0. Routine maintenance.

**Уверенность:** deterministic

**Severity:** Low

---

### SC-004
**File:** `src-tauri/Cargo.lock`

**Дефект:** Two versions of `thiserror` are present in the dependency tree simultaneously (1.0.69 and 2.0.18). The project's own Cargo.toml correctly specifies `thiserror = "2"`, but transitive dependencies (e.g. `auto-launch`, `cairo-rs`) still pull in the v1 series.

**Packages:** `thiserror 1.0.69` (transitive via `auto-launch`, GTK bindings)

**CVE:** None

**Рекомендация:** No immediate action needed — Rust permits multiple versions of the same crate. Monitor: as Tauri's GTK/platform dependencies migrate to thiserror 2, the duplication will resolve. This is a transitive dependency; do not try to force-unify it manually.

**Уверенность:** deterministic

**Severity:** Low

---

### SC-005
**File:** `src-tauri/Cargo.toml`

**Дефект:** `jsonschema` is pinned to an exact version `0.44.1` (no semver flexibility). The crate is actively developed and frequently releases. An exact pin means security patches in patch releases are not picked up by `cargo update`.

**Packages:** `jsonschema`

**CVE:** None found

**Рекомендация:** Change to `jsonschema = { version = "0.44", default-features = false }` to allow patch-level updates while keeping compatibility. Verify with `cargo update -p jsonschema --precise <latest-patch>`.

**Уверенность:** deterministic

**Severity:** Medium

---

### SC-006
**File:** `src-tauri/Cargo.lock`

**Дефект:** Two versions of `base64` coexist (0.21.7 and 0.22.1). The project directly specifies `base64 = "0.22"` which is correct, but a transitive dependency still pulls in the older 0.21.7 series. While 0.21.x has no active CVEs, the duplication inflates binary size.

**Packages:** `base64 0.21.7` (transitive), `base64 0.22.1` (direct)

**CVE:** None

**Рекомендация:** No action required. This resolves naturally as upstream crates update. Monitor via `cargo tree -d` to identify the transitive puller.

**Уверенность:** deterministic

**Severity:** Low

---

## Items Verified as Not Problematic

- **React RSC CVEs (CVE-2025-55182, -55184, -67779):** Affect React Server Components only. Tauri desktop apps do not run a React server — these vulnerabilities are not applicable. Current `react@19.2.4` is the patched version regardless.
- **bytes RUSTSEC-2026-0007 (CVE-2026-25541):** Integer overflow in `BytesMut::reserve`. Fixed in bytes 1.11.1. The Cargo.lock already resolves to 1.11.1 — the project is protected.
- **CVE-2025-58752 (Vite dev server path traversal):** Fixed in 7.0.7+. Project is on 7.3.1 — protected. Only affects dev server exposed via `--host`, which is not typical for this project.
- **regex CVE-2022-24713 (ReDoS):** Fixed in regex 1.5.5. Project uses 1.12.3 — protected.
- **Lock files:** Both `package-lock.json` (lockfileVersion 3) and `Cargo.lock` (version 4) are present and committed. No floating `*` or `latest` references in production deps.
- **Licenses:** All npm packages use MIT. Rust crates: MIT / Apache-2.0. No GPL/AGPL in the dependency graph. License compatibility is clean.
- **Abandoned packages:** No abandoned packages detected. All key deps (Tauri, React, Vite, serde, thiserror, regex) are actively maintained with 2025-2026 releases.
- **GitHub Actions / Docker:** Not present in this project — no CI pipeline files found, no Dockerfile. Out of scope.

---

## Recommended Actions (Priority Order)

1. **SC-005 (Medium):** Relax `jsonschema` pin from `0.44.1` to `"0.44"` in `Cargo.toml` to allow patch security updates.
2. **SC-002 (Low, planned):** Schedule a Vite 8 + plugin-react v6 migration spike — significant build speed gains available.
3. **SC-003 (Low, trivial):** Run `npm update vitest` to pick up 4.1.0.
4. **SC-001 (Low, planned):** Bump TypeScript to 5.9 when convenient.

---

*Sources consulted: NVD, RustSec Advisory DB, npm registry, crates.io, Vite blog, React blog, Tauri release page.*
