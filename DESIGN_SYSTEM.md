# Design System & Canon Map

Thin index of this project's canon. **The guards are the source of truth** — this
file can go stale, the executable guards cannot. If a row here disagrees with the
code, the code wins. Built from a canonize pass (`plans/canon-audit/`).

This stack has **no source-level linter** (ESLint/stylelint are deliberately
absent), so bypassing a shared primitive compiles green. Adoption is therefore
enforced by cheap `?raw`-vitest source-greps + Rust set-equality/exhaustiveness,
all wired into `.github/workflows/ci.yml` (`npm test` + `cargo test`).

## Canon registry

| Need | Canon home | Adoption guard |
|------|-----------|----------------|
| **ActionType** (3 sources of truth) | Rust `src-tauri/src/config.rs:538` `ActionType::ALL` ⇄ FE `src/lib/constants/ui-copy.ts:56` `ACTION_TYPE_LABELS` → `:73` `ALL_ACTION_TYPES` ⇄ schema `schemas/config.v3.schema.json` `$defs.actionType.enum` | `config.rs` test `action_type_set_matches_schema_enum` (`:4283`, set-equality Rust↔schema) + `:553` compile-exhaustive `match` (no `_` arm) + FE `Record<ActionType, …>` (won't compile without label+icon). A missed schema entry is a **save-breaker** — this is the highest-radius canon. |
| FE action-type lists | `ui-copy.ts` `editableActionTypes`/`ACTION_CATEGORIES`/`ACTION_TYPE_ICONS` | All derived from `ALL_ACTION_TYPES` — structurally cannot drift from the type set. |
| **MouseActionKind / MediaKeyKind** (3 SoT, same shape as ActionType) | Rust `config.rs` `MouseActionKind`/`MediaKeyKind` enums ⇄ schema `$defs.mouseActionKind`/`mediaKeyKind` ⇄ FE `ui-copy.ts` `MOUSE_ACTION_LABELS`/`MEDIA_KEY_LABELS` → derived `*_OPTIONS` | `config.rs` tests `mouse_action_kind_set_matches_schema_enum` + `media_key_kind_set_matches_schema_enum` (set-equality Rust↔schema, strings via serde) + per-enum compile-exhaustive `match` (no `_`) + FE `Record<…Kind>` (won't compile without a label). The payload `$ref`s the enum, so a bad value is a clear `schema_violation`, not a deserialize parse-error. |
| `<select>` dropdown | `src/components/shared.tsx` `SelectField` | `src/lib/canon-guards.test.ts:41` — raw `<select>` fails CI outside `SelectField` + 4 documented exceptions. |
| Notice / banner | `shared.tsx` `Notice` | `canon-guards.test.ts:56` — raw `notice notice--` className fails outside `Notice`. |
| Inline styles (CSP) | CSSOM via `useCssVars`/ref | `canon-guards.test.ts:36` — `style={{` fails CI (`style-src` has no `'unsafe-inline'`). |
| IPC event listening | `src/lib/backend.ts` | `canon-guards.test.ts:63` — `@tauri-apps/api/event` import allowed only in `backend.ts`. |
| **UI copy** (all user-facing text) | `src/i18n/locales/{ru,en}.json` (`t(key)` / `i18n.t(key)`) | `canon-guards.test.ts` — Cyrillic literals in `.ts/.tsx` fail CI (2 documented exceptions: profile-name regex, "Русский" endonym). Components resolve via `t`; plain modules via `i18n.t`. |
| Design **color tokens** | `src/App.css :root` `--c-*` (+ `onboarding.css` `--c-text-dim` alias) | `canon-guards.test.ts` — `var(--token, #hex)` fallback fails CI (a stale literal that drifts / masks an undefined token). Cascade `var(--a, var(--b))` + token defs are fine. |
| Tauri command result | `src-tauri/src/command_error.rs` `CommandError` | Applied to all `#[tauri::command]`s by convention. |
| Directory resolution | `src-tauri/src/paths.rs` | Single source of truth; no ad-hoc path building. |
| OS-specific code | `#[cfg(target_os = "windows")]` modules | Compile-gated; CI rust-job runs on `windows-latest`. |
| Action icons (deduped family) | `src/components/icons.tsx` (Copy/Export/Import/Trash) | No guard — see cap below. |

## Adding an `ActionType` (the save-breaker path)

Touch **all four** or a guard fails (which is the point):
1. `config.rs` `ActionType` enum + `ActionType::ALL` (`:538`) + the exhaustive `match` (`:553`).
2. `schemas/config.v3.schema.json` `$defs.actionType.enum`.
3. FE `ui-copy.ts` `ACTION_TYPE_LABELS` + `ACTION_TYPE_ICONS` (compile-guarded `Record`s).
4. Run `cargo test` (set-equality) + `npm test` (FE compile/derive). See `reference_add_action_type_checklist` in memory.

## Deliberate caps (not gaps — do not "fix" by adding guards)

- **One-off inline `<svg>` glyphs** (nav in `Sidebar.tsx`, undo/redo in `Toolbar.tsx`, view-toggle in `MouseVisualization.tsx`, dropzone in `ProfilesWorkspace.tsx`): each used once, not duplicated → no drift risk. `icons.tsx` exists only because Copy/Export/Trash were duplicated at two sizes *and had drifted*. A blanket svg guard would need a whitelist for structural SVG (`MouseVisualizationSvg.tsx`), window chrome (`TitleBar.tsx`), and primitives (`shared.tsx`) — noise devs would disable.
- **Window controls** (`TitleBar.tsx` min/max/close): a deliberate boundary outside the design system.
