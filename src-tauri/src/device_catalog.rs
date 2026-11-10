//! Mice Sidearm drives natively through Razer's vendor HID protocol, one
//! descriptor per model. Everything that differs between models lives here;
//! the wire format they share stays in `mouse_memory`.
//!
//! The Naga V2 HyperSpeed and the Naga V3 Pro are verified on hardware; the
//! others are read only. How a model is added and verified:
//! `docs/ADDING-A-MODEL.md`.

/// How Sidearm puts its signals into a model's buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    /// Persistent records in onboard profile 1, kept by the takeover guard.
    Onboard,
    /// Only the reversible live map (`profile 0`), restored on stop.
    LiveOverlay,
}

/// A model's reversible live-map path (`live_overlay`).
#[derive(Debug)]
pub struct LiveSpec {
    /// Controls remapped only when an enabled action needs them, as
    /// `(control id, button id)`.
    pub extras: &'static [(&'static str, u8)],
    /// Button that holds the firmware Hypershift key on both layers; `None`
    /// takes it from `Settings.hypershift_trigger`.
    pub firmware_trigger: Option<u8>,
    /// Whether the model has several onboard banks (`0x05` profile commands).
    pub banks: bool,
    /// The button that switches banks on the mouse; never stored in a bank.
    pub profile_button: Option<u8>,
    /// Display-name keys of controls that differ from the shared seed, as
    /// `(control id, i18n key)`.
    pub names: &'static [(&'static str, &'static str)],
}

/// One natively supported mouse model.
#[derive(Debug)]
pub struct NativeModel {
    pub name: &'static str,
    /// Name short enough for the tray tooltip, which Windows cuts at 64
    /// characters.
    pub short_name: &'static str,
    /// Config device this model's controls belong to.
    pub device_id: &'static str,
    /// Prefix of this model's control ids in the config (`v3_thumb_01`).
    pub control_prefix: &'static str,
    pub transport: Transport,
    /// `None`: the model has no live-map path.
    pub live: Option<LiveSpec>,
    pub vid: u16,
    /// Every PID the vendor collection can appear under (cable, dongle). The
    /// Bluetooth PID is absent on purpose: that link carries no vendor collection.
    pub pids: &'static [u16],
    /// USB interface whose HID collection takes the vendor feature reports
    /// (openrazer's report index: `3` on the Naga X / Basilisk V3, else `0`).
    pub interface: u8,
    /// Transaction byte of command-class requests.
    pub transaction_id: u8,
    /// Controls whose onboard record emits a key, as `(control id, button id)`.
    pub key_buttons: &'static [(&'static str, u8)],
    /// Key buttons written through a vendor slot instead of the per-button
    /// command, as `(button id, slot)`. Empty for models without the slot path.
    pub slots: &'static [(u8, u8)],
    /// Buttons that must stay plain mouse buttons, as `(control id, button id,
    /// mouse-button value)`.
    pub native_buttons: &'static [(&'static str, u8, u8)],
    pub dpi_min: u16,
    pub dpi_max: u16,
    /// Poll rate (Hz) ↔ wire code of the control-class poll command.
    pub poll_rates: &'static [(u16, u8)],
    /// Where the key buttons send consumer-page signals instead of `F13`..`F24`.
    /// `None` keeps the keyboard signals.
    pub consumer: Option<ConsumerSignals>,
    /// Proven on hardware. An unverified model is only read and gets DPI /
    /// poll-rate writes (each confirmed by read-back); button records, the
    /// offline profile and guard restores are refused for it.
    pub verified: bool,
    /// The firmware plays a plain key record's left Shift `0x02` / left Alt
    /// `0x04` bits. `false` (the V2 HyperSpeed, measured 2026-10-27 at Raw
    /// Input) drops them, so its offline shortcuts with Shift or Alt use the
    /// turbo record; `true` (the V3 Pro, measured 2026-11-10) never gets a
    /// turbo record, which that firmware may repeat on its own.
    pub plain_left_modifiers: bool,
}

/// A model's consumer-page signal path: each key button holds a record of
/// category `0x0a` with a **reserved** consumer usage, which Windows ignores,
/// and Sidearm reads the press straight from the HID collection.
#[derive(Debug)]
pub struct ConsumerSignals {
    /// USB interface and top-level collection that carry the reports
    /// (`MI_01&Col03`, usage page `0x000c`, on the V2 HyperSpeed).
    pub interface: u8,
    pub collection: u8,
    /// First byte of every report read from that collection.
    pub report_id: u8,
    /// `(control id, consumer usage)` for every key button.
    pub usages: &'static [(&'static str, u16)],
}

/// The scroll a live-overlay model's wheel control stands for: its live map
/// holds silent signals, so with no active assignment Sidearm scrolls itself.
pub fn live_wheel_scroll(control_id: &str) -> Option<crate::config::MouseActionKind> {
    use crate::config::MouseActionKind::{ScrollDown, ScrollUp};
    CATALOG.iter().filter(|model| model.transport == Transport::LiveOverlay).find_map(|model| {
        match control_id.strip_prefix(model.control_prefix)? {
            "wheel_up" => Some(ScrollUp),
            "wheel_down" => Some(ScrollDown),
            _ => None,
        }
    })
}

impl NativeModel {
    /// Whether `other` is this model. By name, never by address: a `const`
    /// model is a fresh value at every use, so two references to the same
    /// model need not share an address.
    pub fn is(&self, other: &NativeModel) -> bool {
        self.name == other.name
    }

    /// This model's place in [`CATALOG`] (its device lock and live-map flags);
    /// a model outside the catalog (a test double) takes the first one's.
    pub fn catalog_index(&self) -> usize {
        CATALOG.iter().position(|entry| entry.is(self)).unwrap_or(0)
    }

    /// Consumer usage a key button sends on this model, if it has the path.
    pub fn consumer_usage_for(&self, control_id: &str) -> Option<u16> {
        self.consumer.as_ref()?.usages.iter().find(|(id, _)| *id == control_id).map(|(_, usage)| *usage)
    }

    /// Vendor button id of a control whose onboard record emits a key.
    pub fn button_id_for(&self, control_id: &str) -> Option<u8> {
        self.key_buttons.iter().find(|(id, _)| *id == control_id).map(|(_, button)| *button)
    }

    /// Vendor slot of a key button, when this model writes it through one.
    pub fn slot_for(&self, button_id: u8) -> Option<u8> {
        self.slots.iter().find(|(button, _)| *button == button_id).map(|(_, slot)| *slot)
    }

    /// Wire code of a poll rate the model supports.
    pub fn poll_code_for_hz(&self, hz: u16) -> Option<u8> {
        self.poll_rates.iter().find(|(rate, _)| *rate == hz).map(|(_, code)| *code)
    }

    /// Poll rate (Hz) of a wire code.
    pub fn hz_for_poll_code(&self, code: u8) -> Option<u16> {
        self.poll_rates.iter().find(|(_, c)| *c == code).map(|(rate, _)| *rate)
    }
    /// What the Mouse workspace needs to know about the model: name, DPI
    /// range, poll rates ascending, whether it is verified, whether it is the
    /// one plugged in now, and — for a model with consumer signals — whether
    /// its key buttons send them (`consumer`) or `F13`..`F24`.
    pub fn info(&self, connected: bool, consumer: bool) -> NativeModelInfo {
        let mut poll_rates: Vec<u16> = self.poll_rates.iter().map(|(hz, _)| *hz).collect();
        poll_rates.sort_unstable();
        NativeModelInfo {
            name: self.name,
            device_id: self.device_id,
            dpi_min: self.dpi_min,
            dpi_max: self.dpi_max,
            poll_rates,
            verified: self.verified,
            connected,
            banks: self.live.as_ref().is_some_and(|live| live.banks),
            consumer_signals: self.consumer.as_ref().map(|_| consumer),
        }
    }
}

/// The model's limits as the frontend sees them (`get_native_model`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModelInfo {
    pub name: &'static str,
    pub device_id: &'static str,
    pub dpi_min: u16,
    pub dpi_max: u16,
    pub poll_rates: Vec<u16>,
    pub verified: bool,
    pub connected: bool,
    /// The mouse stores profiles in onboard banks (`live_overlay::Banks`).
    pub banks: bool,
    /// `None`: the model has no consumer path; else whether it is in use.
    pub consumer_signals: Option<bool>,
}

/// Razer Naga V2 HyperSpeed, measured on hardware (2026-10-16/17).
pub const NAGA_V2_HYPERSPEED: NativeModel = NativeModel {
    name: "Razer Naga V2 HyperSpeed",
    short_name: "V2",
    device_id: crate::config::RAZER_NAGA_DEVICE_ID,
    control_prefix: "",
    transport: Transport::Onboard,
    // Used only while a second native mouse is connected (firmware Hypershift
    // keeps each mouse's layer to itself).
    live: Some(LiveSpec { extras: &[], firmware_trigger: None, banks: false, profile_button: None, names: &[] }),
    vid: 0x1532,
    // The receiver; the mouse has no wired data link (Bluetooth is 0x00B5).
    pids: &[0x00B4],
    interface: 0,
    // Same value the captured Synapse traffic uses for control commands.
    transaction_id: 0x1f,
    // Thumbs `0x40..=0x4b` emit bare `F13`..`F24`; the two top buttons hold a
    // key record too but have no vendor slot (measured: `top_aux_01` read back
    // `Alt+F23` after one per-button write).
    key_buttons: &[
        ("thumb_01", 0x40), ("thumb_02", 0x41), ("thumb_03", 0x42), ("thumb_04", 0x43),
        ("thumb_05", 0x44), ("thumb_06", 0x45), ("thumb_07", 0x46), ("thumb_08", 0x47),
        ("thumb_09", 0x48), ("thumb_10", 0x49), ("thumb_11", 0x4a), ("thumb_12", 0x4b),
        ("top_aux_01", 0x0b), ("top_aux_02", 0x0c),
    ],
    // Not arithmetic: the allocation the captured vendor traffic shows; slot
    // 0x1b is a spare duplicate of button 0x4b that is never written.
    slots: &[
        (0x40, 0x07), (0x41, 0x1c), (0x42, 0x1d), (0x43, 0x1e), (0x44, 0x00), (0x45, 0x01),
        (0x46, 0x02), (0x47, 0x03), (0x48, 0x08), (0x49, 0x04), (0x4a, 0x05), (0x4b, 0x06),
    ],
    // Measured by scanning every id with `GET_BUTTON`: these answered category
    // `0x01`; every other id but the key buttons answered status `0x03`.
    // `0x34`/`0x35` are the wheel tilt (Synapse: ScrollLeft/ScrollRight), whose
    // factory value is mouse button 4/5 — hence the control ids.
    native_buttons: &[
        ("mouse_left", 0x01, 1),
        ("mouse_right", 0x02, 2),
        ("wheel_click", 0x03, 3),
        ("wheel_up", 0x09, 0x09),
        ("wheel_down", 0x0a, 0x0a),
        ("mouse_4", 0x34, 4),
        ("mouse_5", 0x35, 5),
    ],
    dpi_min: 100,
    dpi_max: 30_000,
    // Measured: `0x02` read back as the 500 Hz the mouse ran at, a `0x01`
    // write read back as 1000 Hz.
    poll_rates: &[(1000, 0x01), (500, 0x02), (125, 0x08)],
    // Measured 2026-10-26 (plans/onboard-memory/2026-10-16-findings.md): every one
    // of these reserved usages arrived as `02 <usage LE16>` on `MI_01&Col03`,
    // which opens shared next to Razer's driver, and produced no Windows input.
    consumer: Some(ConsumerSignals {
        interface: 1,
        collection: 3,
        report_id: 0x02,
        usages: &[
            ("thumb_01", 0x10), ("thumb_02", 0x11), ("thumb_03", 0x12), ("thumb_04", 0x18),
            ("thumb_05", 0x1c), ("thumb_06", 0x38), ("thumb_07", 0x3c), ("thumb_08", 0x4a),
            ("thumb_09", 0x50), ("thumb_10", 0x58), ("thumb_11", 0x5e), ("thumb_12", 0xf8),
            ("top_aux_01", 0xfc), ("top_aux_02", 0xfe),
        ],
    }),
    verified: true,
    plain_left_modifiers: false,
};

// The models below are NOT verified on hardware (`verified: false`): Sidearm
// only reads them and writes DPI / poll rate. Sources: openrazer
// `razermouse_driver.{h,c}` (PIDs, report interface, transaction byte) and
// daemon `mouse.py` (DPI maximum); key-button ids from Synapse's button table
// as published in BrandonDoster/fang `docs/devices.json` — used only once a
// model is verified. Bluetooth PIDs are left out (no vendor collection).
// How a model moves to `verified`: docs/ADDING-A-MODEL.md.

/// The twelve side buttons `0x40..=0x4b`, shared by every 12-button Naga.
const THUMBS: [(&str, u8); 12] = [
    ("thumb_01", 0x40), ("thumb_02", 0x41), ("thumb_03", 0x42), ("thumb_04", 0x43),
    ("thumb_05", 0x44), ("thumb_06", 0x45), ("thumb_07", 0x46), ("thumb_08", 0x47),
    ("thumb_09", 0x48), ("thumb_10", 0x49), ("thumb_11", 0x4a), ("thumb_12", 0x4b),
];

/// The 12-button plate through the Naga V3 Pro's 2.4 GHz receiver. Verified
/// on hardware 2026-11-08; buttons are written only through the reversible
/// live map (`Transport::LiveOverlay`), never the onboard-profile path.
pub static NAGA_V3_PRO: NativeModel = NativeModel {
    name: "Razer Naga V3 Pro",
    short_name: "V3 Pro",
    device_id: "razer-naga-v3",
    control_prefix: "v3_",
    transport: Transport::LiveOverlay,
    // Measured 2026-11-08 (plans/naga-v3-pro-20261108/findings.md).
    live: Some(LiveSpec {
        extras: &[
            ("top_aux_01", 0x0b),
            ("top_aux_02", 0x0c),
            ("wheel_left", 0x34),
            ("wheel_right", 0x35),
            ("wheel_click", 0x03),
            ("top_special_01", 0x6a),
            ("top_special_02", 0x80),
            ("top_special_03", 0x0e),
            ("wheel_up", 0x09),
            ("wheel_down", 0x0a),
        ],
        // The button under the ring finger.
        firmware_trigger: Some(0x39),
        banks: true,
        profile_button: Some(0x0e),
        names: &[
            ("top_special_01", "control.name.v3ScrollMode"),
            ("top_special_02", "control.name.v3ScrollAux"),
            ("top_special_03", "control.name.v3ProfileButton"),
            ("wheel_left", "control.name.v3TiltLeft"),
            ("wheel_right", "control.name.v3TiltRight"),
            ("hypershift_button", "control.name.v3Ring"),
        ],
    }),
    vid: 0x1532,
    pids: &[0x00e8],
    interface: 3,
    transaction_id: 0x1f,
    key_buttons: &THUMBS,
    slots: &[],
    native_buttons: &[],
    dpi_min: 100,
    dpi_max: 50_000,
    // Measured 2026-11-09: the receiver reported 0x02 at 500 Hz.
    poll_rates: &[(1000, 0x01), (500, 0x02), (125, 0x08)],
    // Usages come from `live_overlay::USAGES`, one per control and layer.
    consumer: Some(ConsumerSignals {
        interface: 1,
        collection: 3,
        report_id: 2,
        usages: &[],
    }),
    verified: true,
    plain_left_modifiers: true,
};

/// Razer Naga V2 Pro (cable `00A7`, HyperSpeed dongle `00A8`). Its 6-button
/// plate (`0x50..=0x55`) has no control ids yet.
pub const NAGA_V2_PRO: NativeModel = NativeModel {
    name: "Razer Naga V2 Pro",
    short_name: "V2 Pro",
    device_id: crate::config::RAZER_NAGA_DEVICE_ID,
    control_prefix: "",
    transport: Transport::Onboard,
    live: None,
    vid: 0x1532,
    pids: &[0x00A7, 0x00A8],
    interface: 0,
    transaction_id: 0x1f,
    // Synapse lists no 0x0b on this model, only 0x0c.
    key_buttons: &[
        THUMBS[0], THUMBS[1], THUMBS[2], THUMBS[3], THUMBS[4], THUMBS[5],
        THUMBS[6], THUMBS[7], THUMBS[8], THUMBS[9], THUMBS[10], THUMBS[11],
        ("top_aux_02", 0x0c),
    ],
    slots: &[],
    native_buttons: &[
        ("mouse_left", 0x01, 1),
        ("mouse_right", 0x02, 2),
        ("wheel_click", 0x03, 3),
        ("mouse_4", 0x04, 4),
        ("mouse_5", 0x05, 5),
        ("wheel_up", 0x09, 0x09),
        ("wheel_down", 0x0a, 0x0a),
    ],
    dpi_min: 100,
    dpi_max: 30_000,
    poll_rates: &[(1000, 0x01), (500, 0x02), (125, 0x08)],
    consumer: None,
    verified: false,
    plain_left_modifiers: false,
};

/// Razer Naga Pro (cable `008F`, dongle `0090`). Swappable side plates; which
/// plate answers on which ids is unknown.
pub const NAGA_PRO: NativeModel = NativeModel {
    name: "Razer Naga Pro",
    short_name: "Naga Pro",
    device_id: crate::config::RAZER_NAGA_DEVICE_ID,
    control_prefix: "",
    transport: Transport::Onboard,
    live: None,
    vid: 0x1532,
    pids: &[0x008F, 0x0090],
    interface: 0,
    transaction_id: 0x1f,
    key_buttons: &[
        THUMBS[0], THUMBS[1], THUMBS[2], THUMBS[3], THUMBS[4], THUMBS[5],
        THUMBS[6], THUMBS[7], THUMBS[8], THUMBS[9], THUMBS[10], THUMBS[11],
        ("top_aux_01", 0x0b), ("top_aux_02", 0x0c),
    ],
    slots: &[],
    native_buttons: &[
        ("mouse_left", 0x01, 1),
        ("mouse_right", 0x02, 2),
        ("wheel_click", 0x03, 3),
        ("mouse_4", 0x04, 4),
        ("mouse_5", 0x05, 5),
        ("wheel_up", 0x09, 0x09),
        ("wheel_down", 0x0a, 0x0a),
    ],
    dpi_min: 100,
    dpi_max: 20_000,
    poll_rates: &[(1000, 0x01), (500, 0x02), (125, 0x08)],
    consumer: None,
    verified: false,
    plain_left_modifiers: false,
};

/// Razer Naga X (wired only, `0096`): no mouse 4/5, no tilt, no top buttons.
pub const NAGA_X: NativeModel = NativeModel {
    name: "Razer Naga X",
    short_name: "Naga X",
    device_id: crate::config::RAZER_NAGA_DEVICE_ID,
    control_prefix: "",
    transport: Transport::Onboard,
    live: None,
    vid: 0x1532,
    pids: &[0x0096],
    interface: 3,
    transaction_id: 0x1f,
    key_buttons: &THUMBS,
    slots: &[],
    native_buttons: &[
        ("mouse_left", 0x01, 1),
        ("mouse_right", 0x02, 2),
        ("wheel_click", 0x03, 3),
        ("wheel_up", 0x09, 0x09),
        ("wheel_down", 0x0a, 0x0a),
    ],
    dpi_min: 100,
    dpi_max: 18_000,
    poll_rates: &[(1000, 0x01), (500, 0x02), (125, 0x08)],
    consumer: None,
    verified: false,
    plain_left_modifiers: false,
};

/// Every natively supported model, probed in this order.
pub static CATALOG: &[&NativeModel; CATALOG_LEN] = &[&NAGA_V2_HYPERSPEED, &NAGA_V2_PRO, &NAGA_PRO, &NAGA_X, &NAGA_V3_PRO];
pub const CATALOG_LEN: usize = 5;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_live_overlay_wheel_falls_back_to_scrolling() {
        use crate::config::MouseActionKind::{ScrollDown, ScrollUp};
        assert_eq!(live_wheel_scroll("v3_wheel_up"), Some(ScrollUp));
        assert_eq!(live_wheel_scroll("v3_wheel_down"), Some(ScrollDown));
        assert_eq!(live_wheel_scroll("wheel_up"), None, "the V2 scrolls by itself");
        assert_eq!(live_wheel_scroll("v3_thumb_01"), None);
    }

    #[test]
    fn every_catalog_model_has_its_own_index() {
        for (index, model) in CATALOG.iter().enumerate() {
            assert_eq!(model.catalog_index(), index, "{}", model.name);
        }
        // A `const` model used directly is the same model as its catalog entry.
        assert_eq!(NAGA_X.catalog_index(), CATALOG.iter().position(|entry| entry.name == NAGA_X.name).unwrap());
        let names: std::collections::HashSet<_> = CATALOG.iter().map(|model| model.name).collect();
        assert_eq!(names.len(), CATALOG.len(), "model names are unique");
    }

    /// The V2 HyperSpeed entry must reproduce the tables v0.9.0 shipped with,
    /// written out here independently of the entry.
    #[test]
    fn naga_v2_hyperspeed_keeps_the_v090_tables() {
        let m = &NAGA_V2_HYPERSPEED;
        assert_eq!((m.vid, m.pids, m.interface, m.transaction_id), (0x1532, &[0x00B4u16][..], 0, 0x1f));
        // Thumbs follow the order of the built-in Naga controls, from 0x40.
        for (index, control) in crate::config::NAGA_CONTROL_IDS.iter().take(12).enumerate() {
            assert_eq!(m.button_id_for(control), Some(0x40 + index as u8), "{control}");
        }
        assert_eq!(m.button_id_for("top_aux_01"), Some(0x0b));
        assert_eq!(m.button_id_for("top_aux_02"), Some(0x0c));
        assert_eq!(m.button_id_for("mouse_left"), None);
        let slots: Vec<u8> = (0x40..=0x4b).map(|b| m.slot_for(b).unwrap()).collect();
        assert_eq!(slots, [0x07, 0x1c, 0x1d, 0x1e, 0x00, 0x01, 0x02, 0x03, 0x08, 0x04, 0x05, 0x06]);
        assert_eq!(m.slot_for(0x0b), None);
        assert_eq!(m.native_buttons.len(), 7);
        assert!(m.native_buttons.contains(&("mouse_4", 0x34, 4)));
        assert_eq!((m.dpi_min, m.dpi_max), (100, 30_000));
        assert_eq!(m.poll_code_for_hz(1000), Some(0x01));
        assert_eq!(m.hz_for_poll_code(0x08), Some(125));
        assert_eq!(m.poll_code_for_hz(2000), None);
    }

    #[test]
    fn info_lists_the_poll_rates_ascending() {
        let info = NAGA_V2_HYPERSPEED.info(true, true);
        assert_eq!(info.name, "Razer Naga V2 HyperSpeed");
        assert_eq!((info.dpi_min, info.dpi_max), (100, 30_000));
        assert_eq!(info.poll_rates, [125, 500, 1000]);
        assert!(info.verified && info.connected);
    }

    /// Only hardware proves a model: flipping `verified` must be a deliberate,
    /// reviewed change of this list.
    #[test]
    fn only_the_hardware_tested_models_are_verified() {
        let verified: Vec<&str> = CATALOG.iter().filter(|m| m.verified).map(|m| m.name).collect();
        assert_eq!(verified, ["Razer Naga V2 HyperSpeed", "Razer Naga V3 Pro"]);
        let names: Vec<&str> = CATALOG.iter().map(|m| m.name).collect();
        assert_eq!(names, ["Razer Naga V2 HyperSpeed", "Razer Naga V2 Pro", "Razer Naga Pro", "Razer Naga X", "Razer Naga V3 Pro"]);
    }

    /// The consumer path covers exactly the key buttons, with distinct usages,
    /// and only on a model whose records Sidearm may write.
    #[test]
    fn consumer_usages_cover_every_key_button_once() {
        for m in CATALOG {
            let Some(consumer) = &m.consumer else { continue };
            if m.transport == Transport::LiveOverlay {
                continue; // Its usages are per layer, tested by `live_overlay`.
            }
            assert!(m.verified, "{}: consumer signals need a verified model", m.name);
            let mut controls: Vec<&str> = consumer.usages.iter().map(|(id, _)| *id).collect();
            let mut keys: Vec<&str> = m.key_buttons.iter().map(|(id, _)| *id).collect();
            controls.sort_unstable();
            keys.sort_unstable();
            assert_eq!(controls, keys, "{}", m.name);
            let mut usages: Vec<u16> = consumer.usages.iter().map(|(_, u)| *u).collect();
            usages.sort_unstable();
            usages.dedup();
            assert_eq!(usages.len(), consumer.usages.len(), "{}: a usage is used twice", m.name);
            assert!(!usages.contains(&0), "{}: usage 0 is the release report", m.name);
        }
        assert_eq!(NAGA_V2_HYPERSPEED.consumer_usage_for("thumb_01"), Some(0x10));
        assert_eq!(NAGA_V2_HYPERSPEED.consumer_usage_for("top_aux_02"), Some(0xfe));
        assert_eq!(NAGA_V2_HYPERSPEED.consumer_usage_for("mouse_left"), None);
    }

    #[test]
    fn catalog_entries_are_internally_consistent() {
        let mut seen_pids = Vec::new();
        for m in CATALOG {
            for pid in m.pids {
                assert!(!seen_pids.contains(&(m.vid, *pid)), "{} pid {pid:#06x} listed twice", m.name);
                seen_pids.push((m.vid, *pid));
            }
            let mut ids: Vec<u8> = m.key_buttons.iter().map(|(_, b)| *b).collect();
            ids.extend(m.native_buttons.iter().map(|(_, b, _)| *b));
            let count = ids.len();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), count, "{}: a button id is used twice", m.name);
            for (button, _) in m.slots {
                assert!(m.key_buttons.iter().any(|(_, b)| b == button), "{}: slot for unknown button", m.name);
            }
            assert!(m.dpi_min >= 100 && m.dpi_min < m.dpi_max, "{}: DPI range", m.name);
        }
    }
}
