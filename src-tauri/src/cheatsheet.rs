//! The HyperShift 2 cheat sheet (`Settings.hs2CheatSheet`): hold the HyperShift
//! 2 trigger (the V3's right button) for [`SHOW_AFTER`] without pressing
//! anything else and the layer's side-button grid shows at the cursor; the
//! release or any press while it is held hides it. The window never takes the
//! focus and lets clicks through (`public/cheatsheet.html` + `cheatsheet.js`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{AppConfig, Gesture, Layer};
use crate::runtime::RuntimeStore;

pub(crate) const WINDOW_LABEL: &str = "cheatsheet";
const EVENT_SHOW: &str = "cheatsheet-show";
const SHOW_AFTER: Duration = Duration::from_millis(1000);

/// Bumps on every hold, release and press: a late timer of an older hold does nothing.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The hold whose sheet the page draws now: its layout shows only while it lasts.
static DRAWN: AtomicU64 = AtomicU64::new(0);
/// The sheet waiting for a page still loading (the first hold creates the window).
static PENDING: Mutex<Option<(u64, Sheet)>> = Mutex::new(None);

/// One side button of the grid.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Cell {
    pub number: u8,
    /// The plain press's label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The other press patterns: "⌛ name", "2× name", "3× name".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extras: Vec<String>,
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
    let mut cells: Vec<Cell> = (1..=12).map(|number| Cell { number, ..Cell::default() }).collect();
    for binding in config.bindings.iter().filter(|b| b.enabled && b.profile_id == profile_id && b.layer == Layer::Hypershift2) {
        let Some(number) = binding.control_id.as_str().strip_prefix("v3_thumb_").and_then(|n| n.parse::<usize>().ok()) else {
            continue;
        };
        let Some(cell) = cells.get_mut(number.wrapping_sub(1)) else { continue };
        match Gesture::of(binding.trigger_mode) {
            Gesture::Press => cell.label = Some(binding.label.clone()),
            Gesture::LongPress => cell.extras.push(format!("⌛ {}", binding.label)),
            Gesture::DoublePress => cell.extras.push(format!("2× {}", binding.label)),
            Gesture::TriplePress => cell.extras.push(format!("3× {}", binding.label)),
        }
    }
    Sheet { title, cells }
}

/// The helper says the HyperShift 2 trigger went down (`held`) or up.
pub(crate) fn trigger_held(app: &AppHandle, runtime_store: &Arc<Mutex<RuntimeStore>>, config: Option<&Arc<AppConfig>>, held: bool) {
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    if !held {
        hide(app);
        return;
    }
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
        if GENERATION.load(Ordering::Acquire) != generation {
            return; // released or pressed meanwhile
        }
        let name = config.profiles.iter().find(|p| p.id == profile_id).map_or(profile_id.as_str(), |p| p.name.as_str());
        let title = crate::ui_text::native(&crate::ui_text!("cheatsheet.title", "{profile} · HyperShift 2", profile = name));
        show(&app, generation, sheet_of(&config, &profile_id, title));
    });
}

/// A button was pressed while the trigger is held: the sheet goes (or never comes).
pub(crate) fn cancel(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    hide(app);
}

fn show(app: &AppHandle, generation: u64, sheet: Sheet) {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        // The page asks for it once loaded (`cheatsheet_ready`).
        *PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((generation, sheet));
        create_window(app);
        return;
    }
    DRAWN.store(generation, Ordering::Release);
    let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &sheet);
}

/// The page loaded: the sheet of a hold still going on.
pub(crate) fn page_ready(app: &AppHandle) {
    let pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    if let Some((generation, sheet)) = pending
        && GENERATION.load(Ordering::Acquire) == generation
    {
        DRAWN.store(generation, Ordering::Release);
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &sheet);
    }
}

/// The page measured itself (physical pixels): place it at the cursor and show
/// it without taking the focus.
pub(crate) fn page_layout(app: &AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    if GENERATION.load(Ordering::Acquire) != DRAWN.load(Ordering::Acquire) {
        return; // released (or pressed) while it was drawn
    }
    platform::place_and_show(&window, width.ceil() as i32, height.ceil() as i32);
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        platform::hide(&window);
    }
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

    pub(super) fn hide(window: &tauri::WebviewWindow) {
        if let Ok(hwnd) = window.hwnd() {
            unsafe { ShowWindow(hwnd.0 as HWND, SW_HIDE) };
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub(super) fn place_and_show(window: &tauri::WebviewWindow, width: i32, height: i32) {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: width as u32, height: height as u32 }));
        let _ = window.show();
    }

    pub(super) fn hide(window: &tauri::WebviewWindow) {
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Binding, ControlId, TriggerMode};

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
        assert_eq!(sheet.cells[0], Cell { number: 1, label: Some("Win+Left".into()), extras: vec!["⌛ Win+D".into()] });
        assert_eq!(sheet.cells[11].label.as_deref(), Some("Tab"));
        assert!(sheet.cells[1].label.is_none());
    }
}
