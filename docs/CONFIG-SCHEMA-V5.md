# Config schema v5

The current schema is `schemas/config.v5.schema.json`. Version 5 keeps everything
in [config schema v4](CONFIG-SCHEMA-V4.md) and adds two things for the Naga V3 Pro.

## Onboard slots per profile

`Profile.deviceSlots` is optional: a map from a built-in device id (for example
`razer-naga-v3`) to one of that mouse's onboard banks, 1 to 5. A bank holds one
profile; the app removes another profile's link when a bank is reassigned.

Banks are written only when Sidearm exits (or the Windows session ends): every
linked profile is stored in its bank, then the offline profile's bank (otherwise
the bank that was playing) is selected. A bank with no linked profile is left as
it is. With a single bank and no link, the offline profile is stored there.

## DPI per mouse

`Profile.deviceMouse` maps a built-in device id to that mouse's own `mouseDpi`,
`mousePollRateHz` and `mouseDpiStages` (DPI 100 to 50000; every write still
respects the connected model's own range). A profile switch writes each connected
mouse's own values; DPI Up/Down steps each mouse through its own stages. The
flat `Profile.mouseDpi`/`mousePollRateHz`/`mouseDpiStages` of v4 are moved on
load to every built-in mouse of the config, so nothing changes until edited.

## Upgrades and rollback

v2, v3 and v4 configs migrate to v5 on load without changing actions,
assignments or the HyperShift trigger. Back up the config before updating. An
older application refuses a v5 config rather than recovering an older backup
over it; restore that application's own pre-update backup when rolling back.
