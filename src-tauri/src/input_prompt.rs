//! Phrases with input fields (`{input:host}`): before such a phrase (or a
//! sequence's text step) runs, a small window at the cursor asks for each field;
//! Enter runs it with the values filled in, Esc or a click elsewhere runs nothing
//! (`public/prompt.html` + `prompt.js`, capability `prompt.json`). Like the menu
//! popup it takes the keyboard focus and gives it back to the window it opened over.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{Action, ActionPayload, AppConfig, SequenceStep, TextSnippetPayload};
use crate::menu_popup::platform;

pub(crate) const WINDOW_LABEL: &str = "prompt";
const EVENT_SHOW: &str = "prompt-show";
const OPEN_TAG: &str = "{input:";

/// The distinct `{input:name}` fields of an action's text, in order of first use.
pub(crate) fn fields_of(config: &AppConfig, action: &Action) -> Vec<String> {
    let mut fields = Vec::new();
    for text in texts_of(config, action) {
        scan(text, |name| {
            if !fields.iter().any(|field| field == name) {
                fields.push(name.to_owned());
            }
            None
        });
    }
    fields
}

/// The action asks for fields before it runs (not in a test run against virtual mice).
pub(crate) fn needs_inputs(config: &AppConfig, action: &Action) -> bool {
    !crate::fake_mode() && !fields_of(config, action).is_empty()
}

fn texts_of<'a>(config: &'a AppConfig, action: &'a Action) -> Vec<&'a str> {
    match &action.payload {
        ActionPayload::TextSnippet(TextSnippetPayload::Inline { text, .. }) => vec![text.as_str()],
        ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id }) => {
            config.snippet_library.iter().filter(|item| &item.id == snippet_id).map(|item| item.text.as_str()).collect()
        }
        ActionPayload::Sequence(sequence) => sequence
            .steps
            .iter()
            .filter_map(|step| match step {
                SequenceStep::Text { value, .. } => Some(value.as_str()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Walks the `{input:name}` tags of `text` (not an escaped `{{input:…}}`);
/// `replace` gives a tag's text, `None` keeps it. Returns the rewritten text.
fn scan(text: &str, mut replace: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(OPEN_TAG) {
        let escaped = rest[..at].ends_with('{');
        let after = &rest[at + OPEN_TAG.len()..];
        let Some(end) = after.find('}') else { break };
        out.push_str(&rest[..at]);
        let name = after[..end].trim();
        match (!escaped && !name.is_empty()).then(|| replace(name)).flatten() {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[at..at + OPEN_TAG.len() + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// `text` with each `{input:name}` replaced by its value. A value is typed as
/// written: its braces are escaped, so `{date}` or `{input:x}` in it stays text.
pub(crate) fn fill(text: &str, values: &HashMap<String, String>) -> String {
    scan(text, |name| values.get(name).map(|value| value.replace('{', "{{").replace('}', "}}")))
}

/// `config` with `action`'s fields filled in: a library text becomes an inline
/// copy for this one run (the library itself is untouched).
pub(crate) fn filled_config(config: &AppConfig, action: &Action, values: &HashMap<String, String>) -> AppConfig {
    let mut filled = action.clone();
    match &mut filled.payload {
        ActionPayload::TextSnippet(TextSnippetPayload::Inline { text, .. }) => *text = fill(text, values),
        ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id }) => {
            if let Some(item) = config.snippet_library.iter().find(|item| &item.id == snippet_id) {
                filled.payload = ActionPayload::TextSnippet(TextSnippetPayload::Inline {
                    text: fill(&item.text, values),
                    paste_mode: item.paste_mode,
                    tags: item.tags.clone(),
                });
            }
        }
        ActionPayload::Sequence(sequence) => {
            for step in &mut sequence.steps {
                if let SequenceStep::Text { value, .. } = step {
                    *value = fill(value, values);
                }
            }
        }
        _ => {}
    }
    let mut config = config.clone();
    if let Some(slot) = config.actions.iter_mut().find(|candidate| candidate.id == filled.id) {
        *slot = filled;
    }
    config
}

type Submit = Box<dyn FnOnce(HashMap<String, String>) + Send>;
type Cancel = Box<dyn FnOnce() + Send>;

/// The question on screen: what Enter and Esc do, and where the focus goes back.
struct Pending {
    generation: u64,
    target_window: isize,
    anchor: (i32, i32),
    submit: Submit,
    cancel: Cancel,
}

/// What `prompt.js` draws.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptView {
    generation: u64,
    title: String,
    fields: Vec<String>,
    hint: String,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
/// The page listens (`prompt_ready`); until then the view waits here.
static READY: AtomicBool = AtomicBool::new(false);
static VIEW: Mutex<Option<PromptView>> = Mutex::new(None);

/// Asks for `fields` at the cursor; `submit` gets the values (after the focus
/// went back to the window it opened over), `cancel` runs when nothing is sent.
/// A question still open is cancelled by a new one.
pub(crate) fn ask(
    app: &AppHandle,
    title: &str,
    fields: Vec<String>,
    submit: impl FnOnce(HashMap<String, String>) + Send + 'static,
    cancel: impl FnOnce() + Send + 'static,
) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let pending = Pending {
        generation,
        target_window: platform::foreground_window(),
        anchor: platform::cursor_position(),
        submit: Box::new(submit),
        cancel: Box::new(cancel),
    };
    let replaced = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).replace(pending);
    if let Some(old) = replaced {
        (old.cancel)();
    }
    let view = PromptView {
        generation,
        title: title.to_owned(),
        fields,
        hint: crate::ui_text::native(&crate::ui_text!("prompt.hint", "Enter: next field, then insert · Esc: cancel")),
    };
    let window = app.get_webview_window(WINDOW_LABEL);
    if window.is_some() && READY.load(Ordering::Acquire) {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &view);
        return;
    }
    *VIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(view);
    if window.is_none() {
        create_window(app);
    }
}

fn create_window(app: &AppHandle) {
    static CREATING: AtomicBool = AtomicBool::new(false);
    let app = app.clone();
    // A menu pick asks on the main thread, where building a window deadlocks.
    crate::spawn_window_build(&CREATING, move || build_window(&app));
}

fn build_window(app: &AppHandle) -> bool {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Err(error) = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("/prompt.html".into()))
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
        log::warn!("[prompt] could not create the window: {error}");
        let pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(pending) = pending {
            (pending.cancel)(); // after the lock: a cancel may ask again
        }
        return false;
    }
    true
}

/// The page listens: it gets the question that waited for it.
pub(crate) fn page_ready(app: &AppHandle) {
    READY.store(true, Ordering::Release);
    let view = VIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    if let Some(view) = view {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &view);
    }
}

/// The page measured itself (physical pixels): size it, put it at the cursor, focus it.
pub(crate) fn page_layout(app: &AppHandle, generation: u64, width: f64, height: f64) {
    let anchor = match PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
        Some(pending) if pending.generation == generation => pending.anchor,
        _ => return,
    };
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    let scale = platform::dpi_scale_at(anchor);
    let (w, h) = (width.ceil().max(1.0) as i32, height.ceil().max(1.0) as i32);
    let (x, y) = platform::position_near(anchor, w, h, (6.0 * scale).round() as i32);
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w as u32, height: h as u32 }));
    platform::show_focused(&window);
}

/// Takes the question `generation` (none when another replaced it) and hides the window.
fn finish(app: &AppHandle, generation: u64) -> Option<Pending> {
    let pending = {
        let mut guard = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.as_ref().filter(|pending| pending.generation == generation)?;
        guard.take()
    };
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        platform::hide_window(&window);
    }
    pending
}

/// Enter: the focus goes back, then the phrase runs with the values (off the UI thread).
pub(crate) fn submit(app: &AppHandle, generation: u64, values: HashMap<String, String>) {
    let Some(pending) = finish(app, generation) else { return };
    let _ = std::thread::Builder::new().name("prompt-run".into()).spawn(move || {
        platform::restore_foreground(pending.target_window);
        // The window it opened over takes the focus back before anything is typed.
        std::thread::sleep(std::time::Duration::from_millis(60));
        (pending.submit)(values);
    });
}

/// Esc, a click elsewhere: nothing is sent.
pub(crate) fn cancel(app: &AppHandle, generation: u64) {
    let Some(pending) = finish(app, generation) else { return };
    platform::restore_foreground(pending.target_window);
    (pending.cancel)();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_found_once_in_order_and_filled() {
        let values: HashMap<String, String> = [("host".to_owned(), "server5".to_owned()), ("user".to_owned(), "admin".to_owned())].into();
        let text = "ssh {input:user}@{input:host} # {input:host} {{input:literal}}";
        let mut fields = Vec::new();
        scan(text, |name| {
            if !fields.iter().any(|field: &String| field == name) {
                fields.push(name.to_owned());
            }
            None
        });
        assert_eq!(fields, ["user", "host"], "an escaped {{input:…}} is no field");
        assert_eq!(fill(text, &values), "ssh admin@server5 # server5 {{input:literal}}");
        assert_eq!(fill("no fields, {date}", &values), "no fields, {date}");
        assert_eq!(fill("broken {input:host", &values), "broken {input:host");
        let tricky: HashMap<String, String> = [("host".to_owned(), "{date} {input:x} {{".to_owned())].into();
        let filled = fill("go {input:host}", &tricky);
        assert_eq!(filled, "go {{date}} {{input:x}} {{{{");
        assert_eq!(crate::input_synthesis::expand_snippet_tokens(&filled).0, "go {date} {input:x} {{", "typed as written");
        let mut asked = Vec::new();
        scan(&filled, |name| { asked.push(name.to_owned()); None });
        assert!(asked.is_empty(), "a value never asks again");
    }

    #[test]
    fn a_library_phrase_is_filled_as_an_inline_copy_for_one_run() {
        use crate::config::{PasteMode, SnippetLibraryItem};
        let mut config = crate::config::default_seed_config();
        config.snippet_library.push(SnippetLibraryItem {
            id: "lib".into(), name: "Login".into(), text: "ssh {input:host}".into(),
            paste_mode: PasteMode::KeyboardOnly, tags: Vec::new(), notes: None,
        });
        let mut action = config.actions[0].clone();
        action.id = "phrase".into();
        action.payload = ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id: "lib".into() });
        config.actions.push(action.clone());
        assert_eq!(fields_of(&config, &action), ["host"]);
        let filled = filled_config(&config, &action, &[("host".to_owned(), "srv".to_owned())].into());
        let run = filled.actions.iter().find(|candidate| candidate.id == "phrase").expect("action");
        assert_eq!(run.payload, ActionPayload::TextSnippet(TextSnippetPayload::Inline {
            text: "ssh srv".into(), paste_mode: PasteMode::KeyboardOnly, tags: Vec::new(),
        }));
        assert_eq!(filled.snippet_library, config.snippet_library, "the library keeps its fields");
    }
}
