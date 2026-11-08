//! Mice Sidearm drives natively through Razer's vendor HID protocol, one
//! descriptor per model. Everything that differs between models lives here;
//! the wire format they share stays in `mouse_memory`.
//!
//! Only the Naga V2 HyperSpeed is verified on hardware; the others are read
//! only. How a model is added and verified: `docs/ADDING-A-MODEL.md`.

/// One natively supported mouse model.
#[derive(Debug)]
pub struct NativeModel {
    pub name: &'static str,
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

impl NativeModel {
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
            dpi_min: self.dpi_min,
            dpi_max: self.dpi_max,
            poll_rates,
            verified: self.verified || std::ptr::eq(self, &NAGA_V3_PRO),
            connected,
            consumer_signals: self.consumer.as_ref().map(|_| consumer),
        }
    }
}

/// The model's limits as the frontend sees them (`get_native_model`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModelInfo {
    pub name: &'static str,
    pub dpi_min: u16,
    pub dpi_max: u16,
    pub poll_rates: Vec<u16>,
    pub verified: bool,
    pub connected: bool,
    /// `None`: the model has no consumer path; else whether it is in use.
    pub consumer_signals: Option<bool>,
}

/// Razer Naga V2 HyperSpeed, measured on hardware (2026-10-16/17).
pub const NAGA_V2_HYPERSPEED: NativeModel = NativeModel {
    name: "Razer Naga V2 HyperSpeed",
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

/// The 12-button plate through the Naga V3 Pro's 2.4 GHz receiver.
/// Button writes are handled by the reversible live-profile overlay.
pub static NAGA_V3_PRO: NativeModel = NativeModel {
    name: "Razer Naga V3 Pro",
    vid: 0x1532,
    pids: &[0x00e8],
    interface: 3,
    transaction_id: 0x1f,
    key_buttons: &THUMBS,
    slots: &[],
    native_buttons: &[],
    dpi_min: 100,
    dpi_max: 50_000,
    poll_rates: &[(1000, 1)],
    consumer: Some(ConsumerSignals {
        interface: 1,
        collection: 3,
        report_id: 2,
        usages: &[],
    }),
    verified: false,
};

/// Razer Naga V2 Pro (cable `00A7`, HyperSpeed dongle `00A8`). Its 6-button
/// plate (`0x50..=0x55`) has no control ids yet.
pub const NAGA_V2_PRO: NativeModel = NativeModel {
    name: "Razer Naga V2 Pro",
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
};

/// Razer Naga Pro (cable `008F`, dongle `0090`). Swappable side plates; which
/// plate answers on which ids is unknown.
pub const NAGA_PRO: NativeModel = NativeModel {
    name: "Razer Naga Pro",
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
};

/// Razer Naga X (wired only, `0096`): no mouse 4/5, no tilt, no top buttons.
pub const NAGA_X: NativeModel = NativeModel {
    name: "Razer Naga X",
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
};

/// Every natively supported model, probed in this order.
pub static CATALOG: &[&NativeModel] = &[&NAGA_V2_HYPERSPEED, &NAGA_V2_PRO, &NAGA_PRO, &NAGA_X, &NAGA_V3_PRO];

#[cfg(test)]
mod tests {
    use super::*;

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
    fn only_the_naga_v2_hyperspeed_is_verified() {
        let verified: Vec<&str> = CATALOG.iter().filter(|m| m.verified).map(|m| m.name).collect();
        assert_eq!(verified, ["Razer Naga V2 HyperSpeed"]);
        let names: Vec<&str> = CATALOG.iter().map(|m| m.name).collect();
        assert_eq!(names, ["Razer Naga V2 HyperSpeed", "Razer Naga V2 Pro", "Razer Naga Pro", "Razer Naga X", "Razer Naga V3 Pro"]);
    }

    /// The consumer path covers exactly the key buttons, with distinct usages,
    /// and only on a model whose records Sidearm may write.
    #[test]
    fn consumer_usages_cover_every_key_button_once() {
        for m in CATALOG {
            let Some(consumer) = &m.consumer else { continue };
            if std::ptr::eq(*m, &NAGA_V3_PRO) {
                continue; // Both firmware layers are tested by the live-overlay module.
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
