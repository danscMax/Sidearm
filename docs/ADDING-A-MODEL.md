# Adding a mouse model

Sidearm drives a Razer mouse itself over the vendor HID protocol: it writes the
button records into the mouse's onboard memory, guards them against Razer
Synapse, and sets DPI / poll rate. Each supported mouse is one `NativeModel`
entry in `src-tauri/src/device_catalog.rs`.

## What a model entry holds

| Field | Meaning |
|---|---|
| `vid`, `pids` | USB ids (cable / receiver / Bluetooth). |
| `interface` | USB interface of the vendor collection (`MI_00` on most Nagas, `MI_03` on the Naga X). |
| `transaction_id` | Byte 1 of every command (`0x1f` on current Nagas). |
| `key_buttons` | Control id → vendor button id of every button that emits a key (thumbs, top buttons). |
| `slots` | Vendor slot of a key button for the slot write path. |
| `native_buttons` | Buttons that must stay plain mouse buttons (left, right, middle, wheel, tilt). |
| `dpi_min`, `dpi_max`, `poll_rates` | Limits shown in the Mouse tab. |
| `consumer` | Optional: reserved consumer usages the key buttons send instead of `F13`..`F24`, and the HID collection that carries them. |
| `verified` | `true` only after the model was proven on hardware (below). |
| `device_id`, `control_prefix` | Config device the model's controls belong to (`razer-naga` for the V2 family) and their id prefix (`v3_`). |
| `transport` | `Onboard`: signals live in onboard profile 1, kept by the takeover guard. `LiveOverlay`: only the reversible live map (`profile 0`), written while Sidearm runs and restored on stop. |
| `live` | Optional `LiveSpec` for the live map: extra controls remapped only when used, the firmware HyperShift button (or the settings trigger), onboard banks, display-name keys. A model with it can run beside a second mouse. |

Shared by every current model: a 90-byte feature report (id `0x03`), XOR checksum
of bytes 2..87, DPI `0x04/0x85`/`0x05`, poll rate `0x00/0x85`/`0x05`, battery
`0x07/0x80`, button records `0x02/0x8c` (read) / `0x02/0x0c` (write) with the
layout `[profile, button, layer, category, length, value…]`.

## Unverified models are read-only

A model with `verified: false` is recognised and its DPI / poll rate work (each
write is confirmed by reading it back), but every write that changes a button is
refused (`VendorDevice::require_verified`): a wrong button id could leave a button
dead outside Sidearm. Its buttons work through recorded signals like any user
device.

## From "recognised" to "verified"

1. **Device report.** An owner of the model opens the Mouse tab and presses
   **Help verify**. Sidearm reads the mouse without changing it (~20 s), copies a
   report (model, firmware, mode, DPI, every button record on both layers) and
   opens the [Device Report](https://github.com/danscMax/Sidearm/issues/new?template=device_report.yml)
   issue form. The report has no serial number.
2. **Button table.** The records in the report give the vendor id of every button.
   Fill `key_buttons`, `slots` and `native_buttons` from it.
3. **Hardware tests.** On the owner's machine, with `verified` flipped to `true`
   locally:

   ```bash
   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture
   ```

   - `prints_the_live_device_report` — read-only.
   - `writes_the_captured_mapping_into_the_live_device` — writes the `F13`..`F24`
     signals; the mouse must echo every write.
   - `consumer_signals_round_trip_on_the_live_device` — models with `consumer` only.
   - `live_dpi_write_leaves_the_stored_dpi` — a live DPI change leaves the stored one.

   The writing tests snapshot the button records first and put them back after.
4. **Pin it.** Set `verified: true` and add the model to the test
   `only_the_hardware_tested_models_are_verified`, which pins the verified list so a
   model cannot become writable by accident.
5. **UI layout.** A model with its own config device gets a `DeviceLayout` in
   `src/lib/devices.ts` (views, hotspots, legend columns, firmware HyperShift button,
   wizard extras) and its control names in both locales. Nothing else in the app
   branches on a model.
