# src/i18n — Localization

## Purpose

i18next setup and the two locale bundles. Every user-facing string lives here.

## Ownership

- `index.ts` — i18next init.
- `locales/en.json`, `locales/ru.json` — the string catalogues.

## Local Contracts

- Every key must exist in BOTH `en.json` and `ru.json`. Add to both in the same change.
- No hardcoded user-facing text in components — add a key and use `t(...)` / `aria-label={t(...)}`.
- Interpolation uses `{{var}}`. A literal single-brace token like `{date}` is fine; never leave an unpaired `{{` in a string (it starts an interpolation).
- Prefer count-in-parens phrasing (`"Selected: {{count}}"`) over noun agreement, or add proper CLDR plural forms (RU needs `_one/_few/_many/_other`).
- Language-neutral tokens (brand names, `PID`, `Ctrl+K`, example paths) may share the same value across locales.

## Work Guidance

- The cosmetic sweep already moved hardcoded strings into locales; keep it that way.

## Verification

- `npm run test` (vitest) — `canon-guards.test.ts` guards against hardcoded UI strings.

## Child DOX Index

- None. Leaf directory.
