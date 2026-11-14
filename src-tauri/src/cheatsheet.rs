//! The HyperShift 2 cheat sheet (`Settings.hs2CheatSheet`): hold the HyperShift
//! 2 trigger (the V3's right button) for [`SHOW_AFTER`] without pressing
//! anything else and the layer's side-button grid shows at the cursor; the
//! release or any press while it is held hides it. The window never takes the
//! focus and lets clicks through (`public/cheatsheet.html` + `cheatsheet.js`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{AppConfig, Gesture, Layer};
use crate::runtime::RuntimeStore;

pub(crate) const WINDOW_LABEL: &str = "cheatsheet";
const EVENT_SHOW: &str = "cheatsheet-show";
pub(crate) const SHOW_AFTER: Duration = Duration::from_millis(1000);

static LIFECYCLE: Mutex<SheetLifecycle> = Mutex::new(SheetLifecycle { generation: 0, drawn: None, pending: None });

#[derive(Default)]
pub(crate) struct SheetLifecycle {
    generation: u64,
    drawn: Option<u64>,
    pending: Option<(u64, Sheet)>,
}

impl SheetLifecycle {
    pub(crate) fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.drawn = None;
        self.pending = None;
        self.generation
    }

    pub(crate) fn draw(&mut self, generation: u64, show: impl FnOnce()) {
        if self.generation == generation {
            self.drawn = Some(generation);
            show();
        }
    }

    /// The current hold's sheet is drawn: the window may be up.
    fn showing(&self) -> bool {
        self.drawn == Some(self.generation)
    }

    pub(crate) fn layout(&self, show: impl FnOnce()) {
        if self.showing() {
            show();
        }
    }

    /// The hide a cancel queued: skipped when a newer hold drew its sheet meanwhile.
    pub(crate) fn settle_hidden(&self, hide: impl FnOnce()) {
        if !self.showing() {
            hide();
        }
    }
}

/// One side button of the grid.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cell {
    pub number: u8,
    /// The plain press's label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The other press patterns, drawn with their marks by the page.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extras: Vec<Extra>,
}

/// A long, double or triple press of a cell's button.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Extra {
    /// `longPress`, `doublePress` or `triplePress`.
    pub gesture: &'static str,
    pub label: String,
}

/// What the page draws.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sheet {
    pub title: String,
    pub cells: Vec<Cell>,
}

/// The HyperShift 2 grid of a profile: the 12 side buttons of the V3 (layout
/// ids `thumb_01`…`thumb_12` with the `v3_` prefix).
pub(crate) fn sheet_of(config: &AppConfig, profile_id: &str, title: String) -> Sheet {
    sheet_of_layer(config, profile_id, "v3_thumb_", Layer::Hypershift2, title)
}

/// The grid of one mouse's 12 side buttons (control ids `<thumbs>01`…`12`) on `layer`.
pub(crate) fn sheet_of_layer(config: &AppConfig, profile_id: &str, thumbs: &str, layer: Layer, title: String) -> Sheet {
    let mut cells: Vec<Cell> = (1..=12).map(|number| Cell { number, ..Cell::default() }).collect();
    for binding in config.bindings.iter().filter(|b| b.enabled && b.profile_id == profile_id && b.layer == layer) {
        let Some(number) = binding.control_id.as_str().strip_prefix(thumbs).and_then(|n| n.parse::<usize>().ok()) else {
            continue;
        };
        let Some(cell) = cells.get_mut(number.wrapping_sub(1)) else { continue };
        let gesture = match Gesture::of(binding.trigger_mode) {
            Gesture::Press => {
                cell.label = Some(binding.label.clone());
                continue;
            }
            Gesture::LongPress => "longPress",
            Gesture::DoublePress => "doublePress",
            Gesture::TriplePress => "triplePress",
        };
        cell.extras.push(Extra { gesture, label: binding.label.clone() });
    }
    Sheet { title, cells }
}

/// The side-button prefix of the mouse `control` belongs to (`v3_thumb_`, `thumb_`).
fn thumb_prefix(config: &AppConfig, control: Option<&str>) -> String {
    let device = control.and_then(|id| config.physical_controls.iter().find(|c| c.id.as_str() == id)).map(|c| c.device_id.as_str());
    config
        .physical_controls
        .iter()
        .filter(|c| device.is_none_or(|device| c.device_id == device))
        .find_map(|c| c.id.as_str().find("thumb_").map(|at| c.id.as_str()[..at + "thumb_".len()].to_owned()))
        .unwrap_or_else(|| "v3_thumb_".to_owned())
}

/// A `cheatSheet` action's sheet is up: the next press puts it away.
static ACTION_SHOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How long a sheet an action showed stays without a press.
const ACTION_SHOWN_FOR: Duration = Duration::from_secs(10);

/// The `cheatSheet` action: the pressed mouse's grid of `layer`, at once.
pub(crate) fn show_layer(app: &AppHandle, config: &AppConfig, profile_id: &str, control: Option<&str>, layer: Layer) {
    let generation = LIFECYCLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).begin();
    ACTION_SHOWN.store(generation, std::sync::atomic::Ordering::SeqCst);
    let name = config.profiles.iter().find(|p| p.id == profile_id).map_or(profile_id, |p| p.name.as_str());
    let layer_name = crate::ui_text::native(&match layer {
        Layer::Standard => crate::ui_text!("cheatsheet.layerStandard", "standard"),
        Layer::Hypershift => crate::ui_text!("cheatsheet.layerHypershift", "HyperShift"),
        Layer::Hypershift2 => crate::ui_text!("cheatsheet.layerHypershift2", "HyperShift 2"),
        Layer::HypershiftBoth => crate::ui_text!("cheatsheet.layerBoth", "HS + HS2"),
    });
    let title = crate::ui_text::native(&crate::ui_text!("cheatsheet.layerTitle", "{profile} · {layer}", profile = name, layer = layer_name));
    show(app, generation, sheet_of_layer(config, profile_id, &thumb_prefix(config, control), layer, title));
    let app = app.clone();
    let _ = std::thread::Builder::new().name("cheatsheet-timeout".into()).spawn(move || {
        std::thread::sleep(ACTION_SHOWN_FOR);
        if ACTION_SHOWN.compare_exchange(generation, 0, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_ok() {
            cancel(&app);
        }
    });
}

/// A press while an action's sheet is up puts it away (one compare otherwise).
pub(crate) fn dismiss_shown(app: &AppHandle) {
    if ACTION_SHOWN.load(std::sync::atomic::Ordering::Relaxed) != 0 && ACTION_SHOWN.swap(0, std::sync::atomic::Ordering::SeqCst) != 0 {
        cancel(app);
    }
}

/// The helper says the HyperShift 2 trigger went down (`held`) or up.
pub(crate) fn trigger_held(app: &AppHandle, runtime_store: &Arc<Mutex<RuntimeStore>>, config: Option<&Arc<AppConfig>>, held: bool) {
    if !held {
        cancel(app);
        return;
    }
    let generation = LIFECYCLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).begin();
    let Some(config) = config.cloned() else { return };
    let profile_id = runtime_store
        .lock()
        .ok()
        .and_then(|store| store.manual_profile_override().map(str::to_owned).or_else(|| {
            store.last_foreground_window().and_then(|window| window.resolved_profile_id.clone())
        }))
        .unwrap_or_else(|| config.settings.fallback_profile_id.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_AFTER);
        let name = config.profiles.iter().find(|p| p.id == profile_id).map_or(profile_id.as_str(), |p| p.name.as_str());
        let title = crate::ui_text::native(&crate::ui_text!("cheatsheet.title", "{profile} · HyperShift 2", profile = name));
        show(&app, generation, sheet_of(&config, &profile_id, title));
    });
}

/// A button was pressed while the trigger is held: the sheet goes (or never comes).
pub(crate) fn cancel(app: &AppHandle) {
    let handle = app.clone();
    cancel_then(&LIFECYCLE, |hide_later| {
        if let Err(error) = app.run_on_main_thread(hide_later) {
            log::warn!("[cheatsheet] hide not scheduled: {error}");
        }
    }, move || {
        if hide(&handle) {
            log::info!("[cheatsheet] hidden");
        }
    });
}

/// Cancels at once and hands `schedule` the hide, which takes the lock again when
/// it runs. A window call off the main thread waits for it, and `page_layout` (a
/// sync command, on the main thread) waits for the lock: the hide must run there,
/// never under the lock.
fn cancel_then(
    lifecycle: &'static Mutex<SheetLifecycle>,
    schedule: impl FnOnce(Box<dyn FnOnce() + Send>),
    hide: impl FnOnce() + Send + 'static,
) {
    lifecycle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).begin();
    schedule(Box::new(move || lifecycle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).settle_hidden(hide)));
}

fn show(app: &AppHandle, generation: u64, sheet: Sheet) {
    let window_exists = app.get_webview_window(WINDOW_LABEL).is_some();
    let mut lifecycle = LIFECYCLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if lifecycle.generation != generation {
        return;
    }
    if !window_exists {
        // The page asks for it once loaded (`cheatsheet_ready`).
        lifecycle.pending = Some((generation, sheet));
        // Window construction may wait for the UI thread, which can itself be cancelling the sheet.
        drop(lifecycle);
        create_window(app);
        return;
    }
    lifecycle.draw(generation, || { let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &sheet); });
}

/// The page loaded: the sheet of a hold still going on.
pub(crate) fn page_ready(app: &AppHandle) {
    let mut lifecycle = LIFECYCLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((generation, sheet)) = lifecycle.pending.take() {
        lifecycle.draw(generation, || { let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &sheet); });
    }
}

/// The page measured itself (physical pixels): place it at the cursor and show
/// it without taking the focus.
pub(crate) fn page_layout(app: &AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    LIFECYCLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).layout(|| {
        platform::place_and_show(&window, width.ceil() as i32, height.ceil() as i32);
        log::info!("[cheatsheet] shown");
    });
}

/// Hides the sheet; whether it was on screen.
fn hide(app: &AppHandle) -> bool {
    app.get_webview_window(WINDOW_LABEL).is_some_and(|window| platform::hide(&window))
}

fn create_window(app: &AppHandle) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    match WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("/cheatsheet.html".into()))
        .title("")
        .inner_size(1.0, 1.0)
        .position(-9999.0, -9999.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .visible(false)
        .transparent(true)
        .shadow(false)
        .build()
    {
        Ok(window) => {
            // Clicks go through to what is under it.
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.hide();
        }
        Err(error) => log::warn!("[cheatsheet] could not create the window: {error}"),
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            HWND_TOPMOST, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SetWindowPos, ShowWindow,
        },
    };

    pub(super) fn place_and_show(window: &tauri::WebviewWindow, width: i32, height: i32) {
        let anchor = crate::platform::display::cursor_position();
        let gap = (12.0 * crate::platform::display::dpi_scale_at(anchor)).round() as i32;
        let (x, y) = crate::platform::display::position_near(anchor, width, height, gap);
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = hwnd.0 as HWND;
        unsafe {
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }

    /// Whether it was visible (`ShowWindow` returns the previous state).
    pub(super) fn hide(window: &tauri::WebviewWindow) -> bool {
        window.hwnd().is_ok_and(|hwnd| unsafe { ShowWindow(hwnd.0 as HWND, SW_HIDE) } != 0)
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub(super) fn place_and_show(window: &tauri::WebviewWindow, width: i32, height: i32) {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: width as u32, height: height as u32 }));
        let _ = window.show();
    }

    pub(super) fn hide(window: &tauri::WebviewWindow) -> bool {
        let visible = window.is_visible().unwrap_or(false);
        let _ = window.hide();
        visible
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Binding, ControlId, TriggerMode};

    #[test]
    fn any_mouse_and_layer_gets_its_own_grid() {
        let mut config = crate::config::default_seed_config();
        let profile = config.settings.fallback_profile_id.clone();
        let template = config.bindings[0].clone();
        for (control, layer, label) in [("thumb_03", Layer::Hypershift, "V2 HS"), ("v3_thumb_03", Layer::Hypershift, "V3 HS"), ("thumb_04", Layer::Standard, "V2 std")] {
            let mut binding = template.clone();
            binding.id = format!("{control}-{label}");
            binding.profile_id = profile.clone();
            binding.control_id = ControlId::new(control);
            binding.layer = layer;
            binding.label = label.into();
            binding.trigger_mode = None;
            binding.enabled = true;
            config.bindings.push(binding);
        }
        let sheet = sheet_of_layer(&config, &profile, "thumb_", Layer::Hypershift, String::new());
        assert_eq!(sheet.cells[2].label.as_deref(), Some("V2 HS"), "the V2's own thumbs on that layer only");
        assert!(sheet.cells[3].label.as_deref() != Some("V2 std"));
        assert_eq!(thumb_prefix(&config, Some("thumb_03")), "thumb_");
    }

    #[test]
    fn stop_cancels_visible_pending_and_delayed_shows() {
        let visible = std::cell::Cell::new(false);
        let mut lifecycle = SheetLifecycle::default();
        let old_timer = lifecycle.begin();
        lifecycle.draw(old_timer, || {});
        lifecycle.layout(|| visible.set(true));
        assert!(visible.get());
        lifecycle.pending = Some((old_timer, Sheet { title: String::new(), cells: Vec::new() }));
        lifecycle.begin();
        lifecycle.settle_hidden(|| visible.set(false));
        assert!(!visible.get());
        assert!(lifecycle.pending.is_none());
        lifecycle.draw(old_timer, || panic!("late timer emitted a stale sheet"));
        lifecycle.layout(|| panic!("late page layout reopened the sheet"));
        let fresh = lifecycle.begin();
        lifecycle.draw(fresh, || {});
        lifecycle.layout(|| visible.set(true));
        assert!(visible.get(), "a subsequent capture session can still show its sheet");
    }

    #[test]
    fn cancel_releases_the_lock_before_its_hide_and_spares_a_newer_sheet() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SHEET: Mutex<SheetLifecycle> = Mutex::new(SheetLifecycle { generation: 0, drawn: None, pending: None });
        static HIDES: AtomicUsize = AtomicUsize::new(0);
        let old = SHEET.lock().unwrap().begin();
        SHEET.lock().unwrap().draw(old, || {});
        let mut queued = Vec::new();
        let schedule = |hide_later: Box<dyn FnOnce() + Send>| {
            // The main thread may be waiting for the lock in `page_layout`.
            assert!(SHEET.try_lock().is_ok(), "the hide is scheduled with the lock held");
            queued.push(hide_later);
        };
        cancel_then(&SHEET, schedule, || { HIDES.fetch_add(1, Ordering::SeqCst); });
        SHEET.lock().unwrap().layout(|| panic!("a cancelled sheet's late layout showed it"));
        queued.pop().unwrap()();
        assert_eq!(HIDES.load(Ordering::SeqCst), 1, "the cancelled sheet is hidden");
        // Cancelled, then a new hold drew before the queued hide ran.
        cancel_then(&SHEET, |hide_later| queued.push(hide_later), || panic!("the stale hide took the new hold's sheet"));
        let fresh = SHEET.lock().unwrap().begin();
        SHEET.lock().unwrap().draw(fresh, || {});
        queued.pop().unwrap()();
    }

    #[test]
    fn the_grid_holds_each_side_button_with_its_press_patterns() {
        let mut config = crate::config::default_seed_config();
        let profile = config.settings.fallback_profile_id.clone();
        let template = config.bindings.first().cloned().expect("a seeded binding");
        let bind = |control: &str, label: &str, mode: Option<TriggerMode>| Binding {
            id: format!("{control}-{label}"),
            profile_id: profile.clone(),
            layer: Layer::Hypershift2,
            control_id: ControlId::new(control),
            label: label.into(),
            trigger_mode: mode,
            enabled: true,
            ..template.clone()
        };
        config.bindings = vec![
            bind("v3_thumb_01", "Win+Left", None),
            bind("v3_thumb_01", "Win+D", Some(TriggerMode::LongPress)),
            bind("v3_thumb_12", "Tab", None),
            bind("thumb_02", "V2 has no HS2", None),
        ];
        let sheet = sheet_of(&config, &profile, "Main · HyperShift 2".into());
        assert_eq!(sheet.cells.len(), 12);
        assert_eq!(
            sheet.cells[0],
            Cell { number: 1, label: Some("Win+Left".into()), extras: vec![Extra { gesture: "longPress", label: "Win+D".into() }] }
        );
        assert_eq!(sheet.cells[11].label.as_deref(), Some("Tab"));
        assert!(sheet.cells[1].label.is_none());
    }
}
