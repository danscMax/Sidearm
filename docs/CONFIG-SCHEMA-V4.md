# Config schema v4

The current schema is `schemas/config.v4.schema.json`. Version 4 retains the
device, control, assignment and global HyperShift model documented in
[config schema v3](CONFIG-SCHEMA-V3.md).

## Profile DPI stages

`Profile.mouseDpiStages` is optional. When present, it contains one to five unique
integer DPI values from 100 to 30000; writes also respect the connected model's
DPI range. Opening the Mouse workspace or migrating a config does not create a
stage list. Explicitly applying a preset or manual value configures the list.

The Mouse workspace has one Sensitivity control: preset segments, a Manual
segment, and one numeric input. Manual selects and focuses the input without
writing to the mouse or saving settings. Applying a value saves the profile's
starting `mouseDpi`; an active profile also applies it to the mouse.

The `mouseAction` kind supports `dpiUp` and `dpiDown`. While Sidearm is running,
these actions read the live DPI and select a higher/lower configured stage.
They stop at the list ends, use live-only writes, and do not change the saved
starting DPI. A missing stage list is reported explicitly.

## Upgrades and rollback

Supported v2/v3 configs migrate to v4 without changing actions, assignments or
the global HyperShift trigger. No stages are invented during migration. The
historical v2/v3 schema files remain available for their respective formats.

Back up the config before updating. An older application requires a compatible
pre-update config when rolling back; do not give a v4 config to v0.11.7. Keep any
newer settings separately before restoring the matching older backup.

Partial mouse readings and summary diagnostics are command responses, not new
persisted configuration fields. Diagnostics do not include profile contents,
serial numbers or user paths.
