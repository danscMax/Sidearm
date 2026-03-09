# Seed Config Plan

- Status: Working draft aligned with config schema v2 and legacy migration notes
- Date: 2026-03-07

## Purpose

This document defines the intended initial dataset for iteration 1.

It serves three purposes:

- provide a concrete bootstrap target for `config.json`
- preserve the useful behavior of the current setup
- keep ambiguous seed data explicit instead of silently normalizing it away

## Seed Scope

Iteration 1 seed data includes:

- the initial profile list
- initial app mappings
- verified thumb-grid encoder mappings
- migrated `Main` and `Code` thumb-grid bindings
- reusable snippet library candidates

Iteration 1 seed data does not claim full verification for:

- top-panel controls
- wheel controls
- every ambiguous Hypershift action

## ID Conventions for Seed Data

Recommended IDs:

- profiles: stable slugs such as `default`, `main`, `code`
- actions: `action-<profile>-<layer>-<control-token>`
- bindings: `binding-<profile>-<layer>-<control-token>`
- app mappings: `app-<exe-without-dot-exe>`
- snippets: `snippet-<purpose>`

`control-token` should reuse the control identity but normalize it to kebab-case inside the generated ID, for example `thumb_01 -> thumb-01`.

These are recommendations for initial import and bootstrap, not a hard forever naming law.

## Seed Profiles

The initial profile set should include:

| profileId | name | enabled | priority | Notes |
| :-- | :-- | :-- | :-- | :-- |
| `default` | Default | `true` | `0` | Safe fallback profile. |
| `main` | Main | `true` | `100` | Primary general workflow profile. |
| `code` | Code | `true` | `200` | Preferred for coding tools. |
| `browser` | Browser | `true` | `100` | General browsing profile. |
| `terminal` | Terminal | `true` | `150` | Shell and terminal workflows. |
| `telegram` | Telegram | `true` | `100` | Messaging workflow. |
| `writing` | Writing | `true` | `100` | Long-form writing workflow. |

## Seed App Mappings

The initial app mappings should migrate the working AHK associations into config v2.

| appMappingId | exe | profileId | enabled | priority | titleIncludes | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `app-code` | `code.exe` | `code` | `true` | `200` | omitted | From legacy setup. |
| `app-cursor` | `cursor.exe` | `code` | `true` | `200` | omitted | From legacy setup. |
| `app-chrome` | `chrome.exe` | `browser` | `true` | `100` | omitted | From legacy setup. |
| `app-msedge` | `msedge.exe` | `browser` | `true` | `100` | omitted | From legacy setup. |
| `app-firefox` | `firefox.exe` | `browser` | `true` | `100` | omitted | From legacy setup. |
| `app-windowsterminal` | `windowsterminal.exe` | `terminal` | `true` | `150` | omitted | From legacy setup. |
| `app-pwsh` | `pwsh.exe` | `terminal` | `true` | `150` | omitted | From legacy setup. |
| `app-cmd` | `cmd.exe` | `terminal` | `true` | `150` | omitted | From legacy setup. |
| `app-telegram` | `telegram.exe` | `telegram` | `true` | `100` | omitted | From legacy setup. |
| `app-notepadpp` | `notepad++.exe` | `writing` | `true` | `100` | omitted | From legacy setup. |

## Seed Encoder Mappings

### Verified Thumb Grid

The thumb grid should be seeded as verified for both supported layers.

| controlId | layer | encodedKey | source | verified |
| :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | `standard` | `F13` | `synapse` | `true` |
| `thumb_02` | `standard` | `F14` | `synapse` | `true` |
| `thumb_03` | `standard` | `F15` | `synapse` | `true` |
| `thumb_04` | `standard` | `F16` | `synapse` | `true` |
| `thumb_05` | `standard` | `F17` | `synapse` | `true` |
| `thumb_06` | `standard` | `F18` | `synapse` | `true` |
| `thumb_07` | `standard` | `F19` | `synapse` | `true` |
| `thumb_08` | `standard` | `F20` | `synapse` | `true` |
| `thumb_09` | `standard` | `F21` | `synapse` | `true` |
| `thumb_10` | `standard` | `F22` | `synapse` | `true` |
| `thumb_11` | `standard` | `F23` | `synapse` | `true` |
| `thumb_12` | `standard` | `F24` | `synapse` | `true` |
| `thumb_01` | `hypershift` | `Ctrl+Alt+Shift+F13` | `synapse` | `true` |
| `thumb_02` | `hypershift` | `Ctrl+Alt+Shift+F14` | `synapse` | `true` |
| `thumb_03` | `hypershift` | `Ctrl+Alt+Shift+F15` | `synapse` | `true` |
| `thumb_04` | `hypershift` | `Ctrl+Alt+Shift+F16` | `synapse` | `true` |
| `thumb_05` | `hypershift` | `Ctrl+Alt+Shift+F17` | `synapse` | `true` |
| `thumb_06` | `hypershift` | `Ctrl+Alt+Shift+F18` | `synapse` | `true` |
| `thumb_07` | `hypershift` | `Ctrl+Alt+Shift+F19` | `synapse` | `true` |
| `thumb_08` | `hypershift` | `Ctrl+Alt+Shift+F20` | `synapse` | `true` |
| `thumb_09` | `hypershift` | `Ctrl+Alt+Shift+F21` | `synapse` | `true` |
| `thumb_10` | `hypershift` | `Ctrl+Alt+Shift+F22` | `synapse` | `true` |
| `thumb_11` | `hypershift` | `Ctrl+Alt+Shift+F23` | `synapse` | `true` |
| `thumb_12` | `hypershift` | `Ctrl+Alt+Shift+F24` | `synapse` | `true` |

### Deferred Top / Wheel Mappings

Top-panel and wheel mappings are not seeded as verified encoder mappings in iteration 1 bootstrap.

They should be introduced through discovery and validation flow after the runtime and UI can represent:

- seeded expectations
- observed emitted keys
- verification outcomes

## Seed Binding and Action Strategy

Each seed binding should reference a reusable action object rather than embedding payloads inline.

Normalization policy:

- shortcut-like AHK strings become `shortcut` actions with structured modifier booleans and `key`
- plain text insertions become `textSnippet`
- unresolved behavior remains unresolved and should not be hidden behind fake precision

## Seed: `Main` Standard Thumb Grid

| controlId | label | action type | normalized intent | Status |
| :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | Delete | `shortcut` | `Delete` | ready |
| `thumb_02` | Backspace | `shortcut` | `Backspace` | ready |
| `thumb_03` | Shift + F3 | `shortcut` | `Shift + F3` | ready |
| `thumb_04` | Ctrl + F | `shortcut` | `Ctrl + F` | ready |
| `thumb_05` | Ctrl + S | `shortcut` | `Ctrl + S` | ready |
| `thumb_06` | Ctrl + Z | `shortcut` | `Ctrl + Z` | ready |
| `thumb_07` | Alt + F4 | `shortcut` | `Alt + F4` | ready |
| `thumb_08` | Enter | `shortcut` | `Enter` | ready |
| `thumb_09` | Ctrl + C | `shortcut` | `Ctrl + C` | ready |
| `thumb_10` | Ctrl + W | `shortcut` | `Ctrl + W` | ready |
| `thumb_11` | Space | `shortcut` | `Space` | ready |
| `thumb_12` | Ctrl + V | `shortcut` | `Ctrl + V` | ready |

## Seed: `Main` Hypershift Thumb Grid

| controlId | label | action type | normalized intent | Status |
| :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | Minus | `shortcut` | `-` | provisional |
| `thumb_02` | Ctrl + Shift + = | `shortcut` | `Ctrl + Shift + =` | ready |
| `thumb_03` | Alt + Ctrl + Shift + R | `shortcut` | `Alt + Ctrl + Shift + R` | ready |
| `thumb_04` | Ctrl + H | `shortcut` | `Ctrl + H` | ready |
| `thumb_05` | Right Ctrl + Right Shift + - | `textSnippet` or `shortcut` | unresolved exact semantics | unresolved |
| `thumb_06` | Ctrl + Y | `shortcut` | `Ctrl + Y` | ready |
| `thumb_07` | Alt + Ctrl + Shift + I | `shortcut` | `Alt + Ctrl + Shift + I` | ready |
| `thumb_08` | Shift + Enter | `shortcut` | `Shift + Enter` | ready |
| `thumb_09` | Copy without paragraphs | `textSnippet` or `sequence` | unresolved exact logic | unresolved |
| `thumb_10` | Ctrl + Shift + T | `shortcut` | `Ctrl + Shift + T` | ready |
| `thumb_11` | Ctrl + Shift + 8 | `shortcut` | `Ctrl + Shift + 8` | ready |
| `thumb_12` | Win + V | `shortcut` | `Win + V` | ready |

## Seed: `Code` Standard Thumb Grid

| controlId | label | action type | normalized intent | Status |
| :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | Delete | `shortcut` | `Delete` | ready |
| `thumb_02` | Backspace | `shortcut` | `Backspace` | ready |
| `thumb_03` | Validation | `textSnippet` | reusable code-review validation prompt | ready |
| `thumb_04` | Ctrl + F | `shortcut` | `Ctrl + F` | ready |
| `thumb_05` | Ctrl + S | `shortcut` | `Ctrl + S` | ready |
| `thumb_06` | Ctrl + Z | `shortcut` | `Ctrl + Z` | ready |
| `thumb_07` | Alt + F4 | `shortcut` | `Alt + F4` | ready |
| `thumb_08` | Enter | `shortcut` | `Enter` | ready |
| `thumb_09` | Ctrl + Insert | `shortcut` | `Ctrl + Insert` | ready |
| `thumb_10` | Ctrl + W | `shortcut` | `Ctrl + W` | ready |
| `thumb_11` | Space | `shortcut` | `Space` | ready |
| `thumb_12` | Shift + Insert | `shortcut` | `Shift + Insert` | ready |

## Seed: `Code` Hypershift Thumb Grid

| controlId | label | action type | normalized intent | Status |
| :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | Ask Me | `textSnippet` | reusable snippet | ready |
| `thumb_02` | Agents | `textSnippet` | reusable snippet | ready |
| `thumb_03` | Best Practices | `textSnippet` | reusable snippet | ready |
| `thumb_04` | /resume | `textSnippet` | reusable snippet | ready |
| `thumb_05` | /max | `textSnippet` | reusable snippet | ready |
| `thumb_06` | Agent Team | `textSnippet` | reusable snippet | ready |
| `thumb_07` | dangerously-skip-permissions-check | `textSnippet` | reusable snippet | ready |
| `thumb_08` | Shift + Enter | `shortcut` | `Shift + Enter` | ready |
| `thumb_09` | fix by GOS | `textSnippet` | reusable snippet | ready |
| `thumb_10` | Shift + Tab | `shortcut` | `Shift + Tab` | ready |
| `thumb_11` | dangerously-bypass-approvals-and-restrictions | `textSnippet` | reusable snippet | ready |
| `thumb_12` | Paste Win | `shortcut` or other | unresolved exact intent | unresolved |

## Seed Snippet Library Candidates

The following reusable texts should start in `snippetLibrary` instead of being duplicated inline.

| snippetId | name | Suggested source |
| :-- | :-- | :-- |
| `snippet-code-validation` | Validation | Legacy `Code` STD `thumb_03` |
| `snippet-ask-me` | Ask Me | Legacy `Code` HS `thumb_01` |
| `snippet-agents-for-analysis` | Agents for Analysis | Legacy `Code` HS `thumb_02` |
| `snippet-best-practices` | Best Practices | Legacy `Code` HS `thumb_03` |
| `snippet-resume` | /resume | Legacy `Code` HS `thumb_04` |
| `snippet-max` | /max | Legacy `Code` HS `thumb_05` |
| `snippet-agent-team` | Agent Team | Legacy `Code` HS `thumb_06` |
| `snippet-danger-skip-permissions` | Danger Skip Permissions | Legacy `Code` HS `thumb_07` |
| `snippet-fix-by-gos` | Fix by GOS | Legacy `Code` HS `thumb_09` |
| `snippet-danger-bypass-restrictions` | Danger Bypass Restrictions | Legacy `Code` HS `thumb_11` |

## Explicitly Unresolved Seed Items

These should remain marked as unresolved during bootstrap work:

- `Main` HS `thumb_05`
- `Main` HS `thumb_09`
- `Code` HS `thumb_12`
- any top-panel and wheel bindings not yet validated on hardware

Unresolved means:

- the control can exist in config
- placeholder labels may exist
- the final payload should not be invented without confirmation

## Import Strategy Implications

Recommended import flow:

1. import seed profiles and app mappings
2. import verified thumb-grid encoder mappings
3. import ready bindings and actions
4. import snippet library entries
5. mark unresolved items clearly for operator review
6. defer top-panel and wheel binding import until discovery support exists

## Implementation Notes

- Initial bootstrap may create all seed data directly as JSON v2 instead of converting INI files at runtime.
- A later migration/import tool can still read legacy AHK/INI data if needed.
- The initial config should prefer correctness and explicit unresolved state over forced completeness.
