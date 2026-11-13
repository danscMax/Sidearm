//! The live popup of a `menu` action.
//!
//! A mouse button opens it at the cursor; while it is open the mouse's own
//! buttons drive it instead of the foreground app: side button N picks item N,
//! the wheel moves the highlight, the wheel click (or tilt right) takes the
//! highlighted item, tilt left goes back out of a submenu, the opening button
//! or any other button closes it. A mouse click on an item picks it too.
//!
//! The popup takes the keyboard focus while open, so typing searches the whole
//! tree, arrows and Enter pick, and Esc closes without reaching the app (in
//! Claude Code Esc would stop the agent). Picking or closing it from the menu
//! hands the focus back to the window it opened over, before the item runs, so
//! the text lands there. A click elsewhere just closes it.
//!
//! [`Model`] is the selection model, pure and independent of the look: the
//! list drawn now and a radial look to come would only differ in how
//! `public/menu.js` draws [`View`].

use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    config::{Action, ActionPayload, AppConfig, MenuActionPayload, MenuItem, SequenceStep, TextSnippetPayload},
    resolver::ResolvedInputPreview,
    runtime::RuntimeStore,
};

/// Items a side button can pick by number (the 12-button grid).
const NUMBERED: usize = 12;
/// Heading of the block of pinned items, shown first.
const PINNED: &str = "★";
pub(crate) const WINDOW_LABEL: &str = "menu";
const EVENT_SHOW: &str = "menu-show";

/// What a press does while the menu is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Input {
    /// Item at this index of the level shown.
    Pick(usize),
    Next,
    Prev,
    Confirm,
    Back,
    Close,
}

/// What the model asks the caller to do after an input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Redraw (or nothing changed).
    Stay,
    /// Close and run this action.
    Run(String),
    Close,
}

/// Selection state. The top level shows its submenus as **blocks** (a heading
/// over their items, inline); a submenu inside a block opens as its own level.
/// A search shows every action of the tree whose name or text matches.
#[derive(Clone, Debug)]
pub(crate) struct Model {
    root: Vec<MenuItem>,
    /// Submenus opened, each as its index in the level shown when it opened.
    path: Vec<usize>,
    highlight: usize,
    query: String,
    /// What each action sends, by action id (see [`action_detail`]).
    details: HashMap<String, String>,
    /// The other menus (action id, name, items): a search also looks there.
    others: Vec<(String, String, Vec<MenuItem>)>,
    /// Ids of menu actions: a link to another menu is no search result there.
    menu_ids: HashSet<String>,
}

/// One row of the level shown: the item, the block it sits in, and for a
/// search result from another menu that menu's action id.
struct Entry<'a> {
    item: &'a MenuItem,
    group: Option<&'a str>,
    menu: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewItem {
    pub label: String,
    /// Its place in the level (1-based); a side button picks it up to [`NUMBERED`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<usize>,
    pub submenu: bool,
    pub enabled: bool,
    /// What it sends (text, keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// For a submenu: the names of what it holds, drawn as a list in the tip.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
    /// The block heading it sits under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// What `menu.js` draws.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct View {
    pub title: String,
    pub items: Vec<ViewItem>,
    pub highlight: usize,
    /// Inside a submenu: the title of the level "back" returns to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub query: String,
    /// The search box's placeholder and the no-results line, in the UI language.
    pub placeholder: String,
    pub empty: String,
    /// The right-click choices for a phrase: insert, insert + Enter, copy only.
    pub pick_modes: Vec<String>,
    /// Bumps on every open, so the page knows a fresh popup needs a layout.
    pub generation: u64,
}

fn item_enabled(item: &MenuItem) -> bool {
    match item {
        MenuItem::Action { enabled, .. } | MenuItem::Submenu { enabled, .. } => *enabled,
    }
}

fn item_pinned(item: &MenuItem) -> bool {
    matches!(item, MenuItem::Action { pinned: true, .. })
}

fn item_label(item: &MenuItem) -> &str {
    match item {
        MenuItem::Action { label, .. } | MenuItem::Submenu { label, .. } => label,
    }
}

impl Model {
    pub(crate) fn new(items: Vec<MenuItem>, details: HashMap<String, String>) -> Self {
        let mut model = Self {
            root: items,
            path: Vec::new(),
            highlight: 0,
            query: String::new(),
            details,
            others: Vec::new(),
            menu_ids: HashSet::new(),
        };
        model.highlight = model.first_enabled().unwrap_or(0);
        model
    }

    /// The other menus a search also looks in (their details must be in the
    /// model's), and the ids of all menu actions.
    pub(crate) fn with_others(mut self, others: Vec<(String, String, Vec<MenuItem>)>, menu_ids: HashSet<String>) -> Self {
        self.others = others;
        self.menu_ids = menu_ids;
        self
    }

    /// A row's menu item id and, for a result from another menu, that menu's id.
    pub(crate) fn item_at(&self, index: usize) -> Option<(String, Option<String>)> {
        let (level, _) = self.walk();
        let entry = level.get(index)?;
        let id = match entry.item {
            MenuItem::Action { id, .. } | MenuItem::Submenu { id, .. } => id.clone(),
        };
        Some((id, entry.menu.map(str::to_owned)))
    }

    /// The action of a row of the level shown.
    pub(crate) fn action_at(&self, index: usize) -> Option<String> {
        match self.walk().0.get(index)?.item {
            MenuItem::Action { action_id, .. } => Some(action_id.clone()),
            MenuItem::Submenu { .. } => None,
        }
    }

    /// The name or the sent text contains the query — also when it was typed
    /// in the other keyboard layout ("ghbyz" finds "Принял", "руддщ" "hello"):
    /// both sides compared as the keys pressed on a ЙЦУКЕН/QWERTY keyboard.
    fn matches(&self, item: &MenuItem, needle: &str) -> bool {
        let MenuItem::Action { label, action_id, .. } = item else { return false };
        let keys = |text: &str| crate::hotkeys::normalize_cyrillic_key(text).to_lowercase();
        let needle_keys = keys(needle);
        let hit = |text: &str| {
            let text = text.to_lowercase();
            text.contains(needle) || keys(&text).contains(&needle_keys)
        };
        hit(label) || self.details.get(action_id).is_some_and(|text| hit(text))
    }

    /// The rows shown and the labels of the submenus opened to get there.
    fn walk(&self) -> (Vec<Entry<'_>>, Vec<&str>) {
        let needle = self.query.trim().to_lowercase();
        if !needle.is_empty() {
            struct Search<'m, 'a> {
                model: &'m Model,
                needle: &'m str,
                seen: HashSet<&'a str>,
                found: Vec<Entry<'a>>,
            }
            // `menu`: another menu searched; its name is the group, its links are skipped.
            fn search<'a>(
                state: &mut Search<'_, 'a>,
                items: &'a [MenuItem],
                group: Option<&'a str>,
                menu: Option<(&'a str, &'a str)>,
            ) {
                for item in items.iter().filter(|item| item_enabled(item)) {
                    match item {
                        MenuItem::Submenu { label, items, .. } => {
                            search(state, items, menu.map(|(_, name)| name).or(Some(label)), menu)
                        }
                        MenuItem::Action { action_id, .. }
                            if state.model.matches(item, state.needle)
                                && !(menu.is_some() && state.model.menu_ids.contains(action_id))
                                && state.seen.insert(action_id) =>
                        {
                            state.found.push(Entry { item, group, menu: menu.map(|(id, _)| id) });
                        }
                        _ => {}
                    }
                }
            }
            let mut state = Search { model: self, needle: &needle, seen: HashSet::new(), found: Vec::new() };
            search(&mut state, &self.root, None, None);
            for (id, name, items) in &self.others {
                search(&mut state, items, Some(name), Some((id, name)));
            }
            return (state.found, Vec::new());
        }
        // Pinned items first, in their own block, and only there.
        let mut level: Vec<Entry<'_>> = Vec::new();
        fn pinned<'a>(items: &'a [MenuItem], level: &mut Vec<Entry<'a>>) {
            for item in items.iter().filter(|item| item_enabled(item)) {
                match item {
                    MenuItem::Submenu { items, .. } => pinned(items, level),
                    _ if item_pinned(item) => level.push(Entry { item, group: Some(PINNED), menu: None }),
                    _ => {}
                }
            }
        }
        pinned(&self.root, &mut level);
        for item in &self.root {
            match item {
                MenuItem::Submenu { label, items, enabled, .. } => {
                    if *enabled {
                        level.extend(
                            items
                                .iter()
                                .filter(|inner| !item_pinned(inner))
                                .map(|inner| Entry { item: inner, group: Some(label.as_str()), menu: None }),
                        );
                    }
                }
                _ if item_pinned(item) => {}
                _ => level.push(Entry { item, group: None, menu: None }),
            }
        }
        let mut labels = Vec::new();
        for &index in &self.path {
            match level.get(index).map(|entry| entry.item) {
                Some(MenuItem::Submenu { label, items, .. }) => {
                    labels.push(label.as_str());
                    level = items.iter().filter(|item| !item_pinned(item)).map(|item| Entry { item, group: None, menu: None }).collect();
                }
                _ => return (Vec::new(), labels),
            }
        }
        (level, labels)
    }

    fn first_enabled(&self) -> Option<usize> {
        self.walk().0.iter().position(|entry| item_enabled(entry.item))
    }

    /// The enabled row one step away from the highlight, wrapping.
    fn step(&self, forward: bool) -> usize {
        let (level, _) = self.walk();
        let len = level.len();
        let mut index = self.highlight.min(len.saturating_sub(1));
        for _ in 0..len {
            index = if forward { (index + 1) % len } else { (index + len - 1) % len };
            if item_enabled(level[index].item) {
                return index;
            }
        }
        self.highlight
    }

    fn take(&mut self, index: usize) -> Step {
        let (level, _) = self.walk();
        let Some(entry) = level.get(index) else { return Step::Stay };
        if !item_enabled(entry.item) {
            return Step::Stay;
        }
        match entry.item {
            MenuItem::Action { action_id, .. } => Step::Run(action_id.clone()),
            MenuItem::Submenu { .. } => {
                self.path.push(index);
                self.highlight = self.first_enabled().unwrap_or(0);
                Step::Stay
            }
        }
    }

    /// A click on a name in a submenu's tip: open it and take that item, as
    /// if the submenu had been opened first (the tip lists its level's rows).
    pub(crate) fn pick_child(&mut self, index: usize, child: usize) -> Step {
        let is_submenu = matches!(self.walk().0.get(index).map(|entry| entry.item), Some(MenuItem::Submenu { enabled: true, .. }));
        if !is_submenu {
            return Step::Stay;
        }
        self.path.push(index);
        match self.take(child) {
            Step::Stay if self.walk().0.get(child).is_some_and(|entry| !matches!(entry.item, MenuItem::Submenu { .. })) => {
                // A disabled row: stay on the level it belongs to.
                self.highlight = child;
                Step::Stay
            }
            step => step,
        }
    }

    pub(crate) fn apply(&mut self, input: Input) -> Step {
        match input {
            Input::Pick(index) => self.take(index),
            Input::Confirm => self.take(self.highlight),
            Input::Next => {
                self.highlight = self.step(true);
                Step::Stay
            }
            Input::Prev => {
                self.highlight = self.step(false);
                Step::Stay
            }
            Input::Back if !self.query.is_empty() => {
                self.set_query("");
                Step::Stay
            }
            Input::Back => match self.path.pop() {
                Some(parent_index) => {
                    self.highlight = parent_index;
                    Step::Stay
                }
                None => Step::Close,
            },
            Input::Close => Step::Close,
        }
    }

    /// Typing in the search box: results from the whole tree, best first.
    pub(crate) fn set_query(&mut self, query: &str) {
        self.query = query.to_owned();
        self.path.clear();
        self.highlight = self.first_enabled().unwrap_or(0);
    }

    /// Highlight a row under the mouse pointer (ignored when disabled).
    pub(crate) fn hover(&mut self, index: usize) -> bool {
        let enabled = self.walk().0.get(index).is_some_and(|entry| item_enabled(entry.item));
        if enabled && self.highlight != index {
            self.highlight = index;
            return true;
        }
        false
    }

    pub(crate) fn view(&self, title: &str, generation: u64) -> View {
        let (level, labels) = self.walk();
        let parent = match labels.len() {
            0 => None,
            1 => Some(title.to_owned()),
            n => Some(labels[n - 2].to_owned()),
        };
        View {
            title: labels.last().copied().unwrap_or(title).to_owned(),
            parent,
            items: level
                .iter()
                .enumerate()
                .map(|(index, entry)| ViewItem {
                    label: item_label(entry.item).to_owned(),
                    number: Some(index + 1),
                    submenu: matches!(entry.item, MenuItem::Submenu { .. }),
                    enabled: item_enabled(entry.item),
                    detail: match entry.item {
                        MenuItem::Action { action_id, .. } => self.details.get(action_id).cloned(),
                        MenuItem::Submenu { .. } => None,
                    },
                    // The rows its level shows (pinned ones live in the ★ block).
                    children: match entry.item {
                        MenuItem::Submenu { items, .. } => {
                            items.iter().filter(|item| !item_pinned(item)).map(|item| item_label(item).to_owned()).collect()
                        }
                        MenuItem::Action { .. } => Vec::new(),
                    },
                    group: entry.group.map(str::to_owned),
                })
                .collect(),
            highlight: self.highlight,
            query: self.query.clone(),
            placeholder: String::new(),
            empty: String::new(),
            pick_modes: Vec::new(),
            generation,
        }
    }
}

/// Longest detail sent to the page; it clamps it further to a few lines.
const DETAIL_CHARS: usize = 600;

fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(DETAIL_CHARS) {
        Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
        None => text.to_owned(),
    }
}

/// What an action puts into the window, as the popup previews it.
pub(crate) fn action_detail(config: &AppConfig, action: &Action) -> Option<String> {
    let text = match &action.payload {
        ActionPayload::TextSnippet(TextSnippetPayload::Inline { text, .. }) => text.clone(),
        ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id }) => {
            config.snippet_library.iter().find(|snippet| &snippet.id == snippet_id)?.text.clone()
        }
        ActionPayload::Sequence(payload) => payload
            .steps
            .iter()
            .filter_map(|step| match step {
                SequenceStep::Text { value, .. } => Some(value.clone()),
                SequenceStep::Send { value, .. } if value.eq_ignore_ascii_case("enter") => Some(" ⏎".into()),
                SequenceStep::Send { value, .. } => Some(format!(" [{value}]")),
                _ => None,
            })
            .collect(),
        ActionPayload::Shortcut(payload) => {
            let mods = [(payload.ctrl, "Ctrl"), (payload.shift, "Shift"), (payload.alt, "Alt"), (payload.win, "Win")];
            let mut parts: Vec<&str> = mods.iter().filter(|(on, _)| *on).map(|(_, name)| *name).collect();
            parts.push(&payload.key);
            parts.join("+")
        }
        _ => return None,
    };
    (!text.trim().is_empty()).then(|| clip(&text))
}

/// The input a press of `control_id` means while the menu is open.
/// `opener` = the button that opened it (pressing it again closes).
pub(crate) fn input_for_control(control_id: &str, opener: bool) -> Input {
    if opener {
        return Input::Close;
    }
    // V3 controls carry a `v3_` prefix; the grid and wheel names are shared.
    let name = control_id.rsplit_once("v3_").map_or(control_id, |(_, rest)| rest);
    if let Some(number) = name.strip_prefix("thumb_").and_then(|n| n.parse::<usize>().ok())
        && (1..=NUMBERED).contains(&number)
    {
        return Input::Pick(number - 1);
    }
    match name {
        "wheel_down" => Input::Next,
        "wheel_up" => Input::Prev,
        "wheel_click" | "wheel_right" | "mouse_5" => Input::Confirm,
        "wheel_left" | "mouse_4" => Input::Back,
        _ => Input::Close,
    }
}

/// Everything needed to run the chosen item as if its button had been pressed.
struct OpenMenu {
    model: Model,
    title: String,
    generation: u64,
    opener_control: Option<String>,
    /// The press that opened it: profile, window, control and layer for the run.
    preview: ResolvedInputPreview,
    config: Arc<AppConfig>,
    runtime_store: Arc<Mutex<RuntimeStore>>,
    is_fg_elevated: bool,
    /// The window in front when it opened (raw HWND), given the focus back
    /// before the item runs if anything took it.
    target_window: isize,
    /// The popup's physical anchor (the cursor at open).
    anchor: (i32, i32),
}

static OPEN: Mutex<Option<OpenMenu>> = Mutex::new(None);
static IS_OPEN: AtomicBool = AtomicBool::new(false);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Cheap check for the capture hot path.
pub(crate) fn is_open() -> bool {
    IS_OPEN.load(Ordering::Acquire)
}

/// Open the popup for a resolved `menu` action.
#[allow(clippy::too_many_arguments)]
pub(crate) fn open(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &ResolvedInputPreview,
    title: &str,
    payload: &MenuActionPayload,
    is_fg_elevated: bool,
) {
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let menus: Vec<(&Action, &MenuActionPayload)> = config
        .actions
        .iter()
        .filter_map(|action| match &action.payload {
            ActionPayload::Menu(menu) => Some((action, menu)),
            _ => None,
        })
        .collect();
    let others: Vec<(String, String, Vec<MenuItem>)> = menus
        .iter()
        .filter(|(action, _)| preview.action_id.as_deref() != Some(action.id.as_str()))
        .map(|(action, menu)| (action.id.clone(), action.display_name.clone(), menu.items.clone()))
        .collect();
    let mut all_items = payload.items.clone();
    all_items.extend(others.iter().flat_map(|(_, _, items)| items.iter().cloned()));
    let menu_ids = menus.iter().map(|(action, _)| action.id.clone()).collect();
    let menu = OpenMenu {
        model: Model::new(payload.items.clone(), menu_details(config, &all_items)).with_others(others, menu_ids),
        title: title.to_owned(),
        generation,
        opener_control: preview.control_id.clone(),
        preview: preview.clone(),
        config: Arc::new(config.clone()),
        runtime_store: runtime_store.clone(),
        is_fg_elevated,
        target_window: platform::foreground_window(),
        anchor: platform::cursor_position(),
    };
    let view = view_of(&menu);
    *OPEN.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(menu);
    IS_OPEN.store(true, Ordering::Release);
    log::info!("[menu] opened `{title}` ({} items)", view.items.len());
    if crate::fake_mode() {
        return; // A test run has no windows; the model still answers presses.
    }
    show(app, &view);
    platform::spawn_watch(app.clone(), generation);
}

/// The open menu's [`View`], with the page's texts in the UI language.
fn view_of(menu: &OpenMenu) -> View {
    let mut view = menu.model.view(&menu.title, menu.generation);
    view.placeholder = crate::ui_text::native(&crate::ui_text!("menu.searchPlaceholder", "Search phrases…"));
    view.empty = crate::ui_text::native(&crate::ui_text!("menu.noResults", "Nothing found"));
    view.pick_modes = vec![
        crate::ui_text::native(&crate::ui_text!("menu.pickRun", "Insert")),
        crate::ui_text::native(&crate::ui_text!("menu.pickEnter", "Insert and press Enter")),
        crate::ui_text::native(&crate::ui_text!("menu.pickCopy", "Only copy to the clipboard")),
        crate::ui_text::native(&crate::ui_text!("menu.pickEdit", "Edit in Sidearm")),
    ];
    view
}

/// [`action_detail`] of every action the menu (and its submenus) can run.
fn menu_details(config: &AppConfig, items: &[MenuItem]) -> HashMap<String, String> {
    let mut details = HashMap::new();
    let mut stack: Vec<&MenuItem> = items.iter().collect();
    while let Some(item) = stack.pop() {
        match item {
            MenuItem::Action { action_id, .. } => {
                let action = config.actions.iter().find(|action| &action.id == action_id);
                if let Some(detail) = action.and_then(|action| action_detail(config, action)) {
                    details.insert(action_id.clone(), detail);
                }
            }
            MenuItem::Submenu { items, .. } => stack.extend(items),
        }
    }
    details
}

fn show(app: &AppHandle, view: &View) {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        // The page asks for the view once loaded (`menu_ready`). No window, no
        // menu: an invisible one would swallow the buttons.
        if !create_window(app) {
            close(app);
        }
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, view);
}

fn create_window(app: &AppHandle) -> bool {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    match WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("/menu.html".into()))
        .title("")
        .inner_size(1.0, 1.0)
        .position(-9999.0, -9999.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .visible(false)
        // Transparent around the list and the tip: only they show.
        .transparent(true)
        .shadow(false)
        .build()
    {
        Ok(window) => {
            let _ = window.hide();
            true
        }
        Err(error) => {
            log::warn!("[menu] could not create the popup window: {error}");
            false
        }
    }
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        platform::hide_window(&window);
    }
}

/// Close without running anything; the window it opened over is not touched
/// (the user clicked elsewhere, or another window came up).
pub(crate) fn close(app: &AppHandle) {
    close_and_return(app, false);
}

/// Close; `return_focus`: give the focus back to the window it opened over.
fn close_and_return(app: &AppHandle, return_focus: bool) {
    let menu = OPEN.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    IS_OPEN.store(false, Ordering::Release);
    hide(app);
    if let Some(menu) = menu {
        log::info!("[menu] closed");
        if return_focus {
            platform::restore_foreground(menu.target_window);
        }
    }
}

/// How a picked item runs (the popup's right-click menu offers the others).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PickMode {
    /// As configured.
    Run,
    /// As configured, then Enter.
    Enter,
    /// Only put its text into the clipboard: nothing is typed.
    Copy,
}

/// The whole text a phrase types (no preview clipping), for "copy only".
fn full_text(config: &AppConfig, action_id: &str) -> Option<String> {
    let action = config.actions.iter().find(|action| action.id == action_id)?;
    match &action.payload {
        ActionPayload::TextSnippet(TextSnippetPayload::Inline { text, .. }) => Some(text.clone()),
        ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id }) => {
            config.snippet_library.iter().find(|snippet| &snippet.id == snippet_id).map(|snippet| snippet.text.clone())
        }
        ActionPayload::Sequence(payload) => {
            let text: String = payload
                .steps
                .iter()
                .filter_map(|step| match step {
                    SequenceStep::Text { value, .. } => Some(value.as_str()),
                    _ => None,
                })
                .collect();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// Feed one input; redraw, run or close as the model says.
fn drive(app: &AppHandle, input: impl FnOnce(&mut Model) -> Step) {
    drive_as(app, PickMode::Run, input);
}

fn drive_as(app: &AppHandle, mode: PickMode, input: impl FnOnce(&mut Model) -> Step) {
    let mut guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(menu) = guard.as_mut() else { return };
    match input(&mut menu.model) {
        Step::Stay => {
            let view = view_of(menu);
            drop(guard);
            if !crate::fake_mode() {
                let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &view);
            }
        }
        Step::Close => {
            drop(guard);
            close_and_return(app, true);
        }
        Step::Run(action_id) => {
            let Some(menu) = guard.take() else { return };
            IS_OPEN.store(false, Ordering::Release);
            drop(guard);
            hide(app);
            platform::restore_foreground(menu.target_window);
            log::info!("[menu] picked `{action_id}` ({mode:?})");
            crate::menu_usage::count(&action_id);
            if mode == PickMode::Copy
                && let Some(text) = full_text(&menu.config, &action_id)
            {
                crate::press_log::count(None, &action_id);
                // What it would type: tokens filled in, the {cursor} marker gone.
                let text = crate::input_synthesis::expand_snippet_tokens(&text).0;
                if !crate::fake_mode()
                    && let Err(error) = crate::input_synthesis::clipboard_set_text(&text)
                {
                    log::warn!("[menu] could not copy `{action_id}`: {error}");
                }
                return;
            }
            crate::capture_backend::run_menu_item(
                app,
                &menu.runtime_store,
                &menu.config,
                &menu.preview,
                &action_id,
                menu.is_fg_elevated,
            );
            if mode == PickMode::Enter && !crate::fake_mode() {
                // The same pause a phrase with Enter keeps before it.
                std::thread::sleep(std::time::Duration::from_millis(80));
                // Not into another window that came up meanwhile: it would submit there.
                if menu.target_window == 0 || platform::foreground_window() == menu.target_window {
                    let _ = crate::input_synthesis::send_hotkey_string("Enter", &crate::hotkeys::HotkeyModifiers::default());
                } else {
                    log::warn!("[menu] Enter skipped: the window in front changed while the text was typed");
                }
            }
        }
    }
}

/// A press of a mouse button while the menu is open (key-downs only).
pub(crate) fn handle_press(app: &AppHandle, control_id: Option<&str>) {
    let opener = {
        let guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(menu) = guard.as_ref() else { return };
        control_id.is_some() && menu.opener_control.as_deref() == control_id
    };
    let input = control_id.map_or(Input::Close, |control| input_for_control(control, opener));
    drive(app, |model| model.apply(input));
}

/// The page under the mouse: a click picks, a hover highlights.
/// The main window is asked to edit this menu item (`menu_edit_requested`).
pub(crate) const EDIT_EVENT: &str = "menu_edit_requested";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditRequest {
    /// The menu action the item belongs to.
    pub menu_action_id: String,
    pub item_id: String,
    /// The profile of the press that opened the menu (its binding is preferred).
    pub profile_id: Option<String>,
}

/// Right click → Edit: close the menu, bring Sidearm up, ask it to open the
/// row's item in its menu editor.
pub(crate) fn edit_from_window(app: &AppHandle, index: usize) {
    let request = {
        let mut guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(menu) = guard.as_ref() else { return };
        let Some((item_id, other)) = menu.model.item_at(index) else { return };
        let Some(menu_action_id) = other.or_else(|| menu.preview.action_id.clone()) else { return };
        let request = EditRequest { menu_action_id, item_id, profile_id: menu.preview.resolved_profile_id.clone() };
        *guard = None;
        request
    };
    IS_OPEN.store(false, Ordering::Release);
    hide(app);
    log::info!("[menu] edit `{}` in `{}`", request.item_id, request.menu_action_id);
    crate::bring_main_window_to_front(app);
    let _ = app.emit_to("main", EDIT_EVENT, &request);
}

pub(crate) fn pick_child_from_window(app: &AppHandle, index: usize, child: usize) {
    drive(app, |model| model.pick_child(index, child));
}

pub(crate) fn pick_from_window(app: &AppHandle, index: usize, mode: PickMode) {
    drive_as(app, mode, |model| model.apply(Input::Pick(index)));
}

/// The whole text of a row (no preview clipping), for the tip held on it.
pub(crate) fn full_text_at(index: usize) -> Option<String> {
    let guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
    let menu = guard.as_ref()?;
    full_text(&menu.config, &menu.model.action_at(index)?)
}

pub(crate) fn hover_from_window(app: &AppHandle, index: usize) {
    let mut guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(menu) = guard.as_mut() else { return };
    if menu.model.hover(index) {
        let view = view_of(menu);
        drop(guard);
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &view);
    }
}

/// The search box changed.
pub(crate) fn search_from_window(app: &AppHandle, query: &str) {
    drive(app, |model| {
        model.set_query(query);
        Step::Stay
    });
}

/// Enter in the page: take the highlighted row.
pub(crate) fn confirm_from_window(app: &AppHandle) {
    drive(app, |model| model.apply(Input::Confirm));
}

/// Esc in the page.
pub(crate) fn close_from_window(app: &AppHandle) {
    drive(app, |model| model.apply(Input::Close));
}

/// A wheel tick or an arrow key in the page.
pub(crate) fn wheel_from_window(app: &AppHandle, down: bool) {
    drive(app, |model| model.apply(if down { Input::Next } else { Input::Prev }));
}

pub(crate) fn back_from_window(app: &AppHandle) {
    drive(app, |model| model.apply(Input::Back));
}

/// The page loaded: send it what to draw.
pub(crate) fn page_ready(app: &AppHandle) {
    let view = {
        let guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().map(view_of)
    };
    if let Some(view) = view {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &view);
    }
}

/// The page measured itself (CSS pixels): size it and put it at the cursor.
/// Once per level: the page keeps its size while the highlight moves.
pub(crate) fn page_layout(app: &AppHandle, generation: u64, width: f64, height: f64) {
    let anchor = {
        let guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        match guard.as_ref() {
            Some(menu) if menu.generation == generation => menu.anchor,
            _ => return, // A late layout of a menu already closed.
        }
    };
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    // The page sends its size in physical pixels (its own devicePixelRatio):
    // a fresh window still sitting on another monitor renders at that
    // monitor's scale, and multiplying by the target's scale cut the menu off.
    // The page measures again once the move changes its scale.
    let scale = platform::dpi_scale_at(anchor);
    let (w, h) = (width.ceil() as i32, height.ceil() as i32);
    let (x, y) = platform::position_near(anchor, w, h, (6.0 * scale).round() as i32);
    // Position first so a cross-monitor DPI change settles before sizing (see `show_osd`).
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w as u32, height: h as u32 }));
    // Shown and focused right here, synchronously: Tauri's `show()` runs later
    // on its event thread, and a `set_focus()` before it lands does nothing
    // (the keys then went to the app under the popup — measured 2026-11-12).
    platform::show_focused(&window);
}

/// Whether the open menu (if any) is `generation`.
fn is_generation(generation: u64) -> bool {
    OPEN.lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .is_some_and(|menu| menu.generation == generation)
}

#[cfg(target_os = "windows")]
mod platform {
    use std::time::Duration;

    use tauri::AppHandle;

    /// A forgotten menu must not keep the mouse's buttons for good.
    const MAX_OPEN: Duration = Duration::from_secs(60);
    use windows_sys::Win32::{
        Foundation::{HWND, POINT, RECT},
        System::Threading::{AttachThreadInput, GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, SetFocus, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON},
            WindowsAndMessaging::{
                BringWindowToTop, GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
                SW_HIDE, SW_SHOW, SetForegroundWindow, ShowWindow,
            },
        },
    };

    pub(super) use crate::platform::display::{cursor_position, dpi_scale_at, position_near};

    pub(super) fn foreground_window() -> isize {
        unsafe { GetForegroundWindow() as isize }
    }

    /// Bring `hwnd` to the front with the keyboard focus. Windows refuses
    /// `SetForegroundWindow` to a process that is not in front (the foreground
    /// lock); sharing the input state with the window in front lifts it.
    fn activate(hwnd: HWND) {
        unsafe {
            let front = GetForegroundWindow();
            if front == hwnd {
                return;
            }
            let ours = GetCurrentThreadId();
            let theirs = if front.is_null() { 0 } else { GetWindowThreadProcessId(front, std::ptr::null_mut()) };
            let attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, 1) != 0;
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SetFocus(hwnd);
            if attached {
                AttachThreadInput(ours, theirs, 0);
            }
        }
    }

    /// Show the popup and give it the keyboard focus.
    pub(super) fn show_focused(window: &tauri::WebviewWindow) {
        match window.hwnd() {
            Ok(hwnd) => {
                let hwnd = hwnd.0 as HWND;
                unsafe {
                    ShowWindow(hwnd, SW_SHOW);
                }
                activate(hwnd);
                if foreground_window() != hwnd as isize {
                    log::warn!("[menu] the popup did not get the keyboard focus");
                }
            }
            Err(_) => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }

    /// Hidden the way it was shown (Tauri's own state never saw it shown).
    pub(super) fn hide_window(window: &tauri::WebviewWindow) {
        match window.hwnd() {
            Ok(hwnd) => unsafe {
                ShowWindow(hwnd.0 as HWND, SW_HIDE);
            },
            Err(_) => {
                let _ = window.hide();
            }
        }
    }

    /// Give the focus back to the window the menu opened over (the popup had it).
    pub(super) fn restore_foreground(target: isize) {
        if target == 0 || foreground_window() == target {
            return;
        }
        activate(target as HWND);
        std::thread::sleep(Duration::from_millis(40));
    }

    fn pressed(vk: u16) -> bool {
        // High bit: down now. Polling is enough: it runs only while a menu is open.
        unsafe { (GetAsyncKeyState(i32::from(vk)) as u16 & 0x8000) != 0 }
    }

    fn cursor_in(window: Option<HWND>) -> bool {
        let Some(hwnd) = window else { return false };
        unsafe {
            let mut rect: RECT = std::mem::zeroed();
            let mut pt: POINT = std::mem::zeroed();
            GetWindowRect(hwnd, &mut rect) != 0
                && GetCursorPos(&mut pt) != 0
                && (rect.left..rect.right).contains(&pt.x)
                && (rect.top..rect.bottom).contains(&pt.y)
        }
    }

    /// Close the menu when the user goes elsewhere: a click outside it, another
    /// window coming to the front, or [`MAX_OPEN`] without a choice.
    pub(super) fn spawn_watch(app: AppHandle, generation: u64) {
        let target = foreground_window();
        let _ = std::thread::Builder::new().name("menu-watch".into()).spawn(move || {
            use tauri::Manager;
            let buttons = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON];
            // A button already down at open (the HyperShift 2 trigger) is not a click.
            let mut was_down: Vec<bool> = buttons.iter().map(|&vk| pressed(vk)).collect();
            let opened = std::time::Instant::now();
            while super::is_generation(generation) {
                std::thread::sleep(Duration::from_millis(25));
                let menu_hwnd = app
                    .get_webview_window(super::WINDOW_LABEL)
                    .and_then(|window| window.hwnd().ok())
                    .map(|hwnd| hwnd.0 as HWND);
                let front = foreground_window();
                let mut close = (front != target && Some(front as HWND) != menu_hwnd)
                    || opened.elapsed() > MAX_OPEN;
                for (index, &vk) in buttons.iter().enumerate() {
                    let down = pressed(vk);
                    if down && !was_down[index] && !cursor_in(menu_hwnd) {
                        close = true;
                    }
                    was_down[index] = down;
                }
                if close && super::is_generation(generation) {
                    super::close(&app);
                    break;
                }
            }
        });
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    pub(super) fn foreground_window() -> isize {
        0
    }
    pub(super) fn cursor_position() -> (i32, i32) {
        (100, 100)
    }
    pub(super) fn dpi_scale_at(_: (i32, i32)) -> f64 {
        1.0
    }
    pub(super) fn position_near(point: (i32, i32), _: i32, _: i32, gap: i32) -> (i32, i32) {
        (point.0 + gap, point.1 + gap)
    }
    pub(super) fn restore_foreground(_: isize) {}
    pub(super) fn show_focused(window: &tauri::WebviewWindow) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    pub(super) fn hide_window(window: &tauri::WebviewWindow) {
        let _ = window.hide();
    }
    pub(super) fn spawn_watch(_: AppHandle, _: u64) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(id: &str, label: &str) -> MenuItem {
        MenuItem::Action { id: id.into(), label: label.into(), action_id: format!("act-{id}"), enabled: true, pinned: false }
    }

    fn submenu(id: &str, label: &str, items: Vec<MenuItem>) -> MenuItem {
        MenuItem::Submenu { id: id.into(), label: label.into(), enabled: true, items }
    }

    /// Ask, a disabled item, then a block "Check" (Validate, Review, a "More" submenu), then Continue.
    fn sample() -> Model {
        let details = HashMap::from([("act-v".to_owned(), "/max:validate".to_owned())]);
        Model::new(
            vec![
                action("a", "Ask"),
                MenuItem::Action { id: "off".into(), label: "Off".into(), action_id: "act-off".into(), enabled: false, pinned: false },
                submenu("s", "Check", vec![action("v", "Validate"), action("r", "Review"), submenu("m", "More", vec![action("x", "Deep")])]),
                action("c", "Continue"),
            ],
            details,
        )
    }

    fn labels(view: &View) -> Vec<&str> {
        view.items.iter().map(|item| item.label.as_str()).collect()
    }

    #[test]
    fn a_name_in_a_submenu_tip_is_taken_without_opening_the_submenu_first() {
        let mut model = sample();
        // "More" (row 4 of the top level) holds "Deep"; its tip lists it.
        assert_eq!(model.view("Phrases", 1).items[4].children, ["Deep"]);
        assert_eq!(model.pick_child(4, 0), Step::Run("act-x".into()));
        // Not a submenu: nothing happens.
        assert_eq!(sample().pick_child(0, 0), Step::Stay);
    }

    #[test]
    fn pinned_items_come_first_in_their_own_block_and_only_there() {
        let pinned = MenuItem::Action { id: "r".into(), label: "Review".into(), action_id: "act-r".into(), enabled: true, pinned: true };
        let model = Model::new(vec![action("a", "Ask"), submenu("s", "Check", vec![action("v", "Validate"), pinned])], HashMap::new());
        let view = model.view("Phrases", 1);
        assert_eq!(labels(&view), ["Review", "Ask", "Validate"]);
        assert_eq!(view.items[0].group.as_deref(), Some(PINNED));
        assert_eq!(model.action_at(0).as_deref(), Some("act-r"));
    }

    #[test]
    fn a_search_also_finds_other_menus_under_their_name_without_their_links() {
        let mut model = sample().with_others(
            vec![(
                "menu-2".into(),
                "Commands".into(),
                vec![
                    submenu("cc", "Claude", vec![action("model", "/model"), action("val2", "Validate twice")]),
                    MenuItem::Action { id: "back".into(), label: "Validate menu".into(), action_id: "menu-1".into(), enabled: true, pinned: false },
                ],
            )],
            HashSet::from(["menu-1".to_owned()]),
        );
        model.set_query("valid");
        let view = model.view("Phrases", 1);
        assert_eq!(labels(&view), ["Validate", "Validate twice"]);
        assert_eq!(view.items[1].group.as_deref(), Some("Commands"));
        model.set_query("ьщвуд"); // "model" typed in the Russian layout
        assert_eq!(labels(&model.view("Phrases", 1)), ["/model"]);
    }

    #[test]
    fn a_top_level_submenu_is_a_block_shown_inline() {
        let view = sample().view("Phrases", 1);
        assert_eq!(labels(&view), ["Ask", "Off", "Validate", "Review", "More", "Continue"]);
        assert_eq!(view.items[2].group.as_deref(), Some("Check"));
        assert_eq!(view.items[0].group, None);
        assert_eq!(view.items[5].number, Some(6), "numbers run on across blocks");
    }

    #[test]
    fn a_side_button_picks_the_item_with_its_number() {
        let mut model = sample();
        assert_eq!(model.apply(Input::Pick(3)), Step::Run("act-r".into()), "inside a block");
        assert_eq!(model.apply(Input::Pick(1)), Step::Stay, "a disabled item does nothing");
        assert_eq!(model.apply(Input::Pick(9)), Step::Stay, "past the end does nothing");
    }

    #[test]
    fn the_wheel_skips_disabled_items_and_wraps() {
        let mut model = sample();
        assert_eq!(model.highlight, 0);
        model.apply(Input::Next);
        assert_eq!(model.highlight, 2, "the disabled item is skipped");
        model.apply(Input::Prev);
        model.apply(Input::Prev);
        assert_eq!(model.highlight, 5, "wraps to the bottom");
        assert_eq!(model.apply(Input::Confirm), Step::Run("act-c".into()));
    }

    #[test]
    fn a_submenu_in_a_block_opens_as_a_level_and_back_returns() {
        let mut model = sample();
        assert_eq!(model.apply(Input::Pick(4)), Step::Stay);
        let view = model.view("Phrases", 1);
        assert_eq!(view.title, "More");
        assert_eq!(view.parent.as_deref(), Some("Phrases"), "back names the level it returns to");
        assert_eq!(labels(&view), ["Deep"]);
        assert_eq!(model.apply(Input::Back), Step::Stay);
        assert_eq!(model.highlight, 4, "back highlights the submenu it came from");
        assert_eq!(model.apply(Input::Back), Step::Close, "back at the top closes");
    }

    #[test]
    fn search_finds_names_and_texts_in_the_whole_tree() {
        let mut model = sample();
        model.set_query("DEE");
        let view = model.view("Phrases", 1);
        assert_eq!(labels(&view), ["Deep"], "inside a nested submenu, case-insensitive");
        assert_eq!(view.items[0].group.as_deref(), Some("More"));
        model.set_query("max:val");
        assert_eq!(labels(&model.view("Phrases", 1)), ["Validate"], "matched by what it sends");
        assert_eq!(model.apply(Input::Pick(0)), Step::Run("act-v".into()));
        model.set_query("off");
        assert!(model.view("Phrases", 1).items.is_empty(), "disabled items are not found");
        assert_eq!(model.apply(Input::Back), Step::Stay, "back clears the search first");
        assert_eq!(model.view("Phrases", 1).items.len(), 6);
        model.set_query("Вуу");
        assert_eq!(labels(&model.view("Phrases", 1)), ["Deep"], "typed in the Russian layout");
    }

    #[test]
    fn controls_map_to_menu_inputs() {
        assert_eq!(input_for_control("v3_thumb_05", false), Input::Pick(4));
        assert_eq!(input_for_control("thumb_12", false), Input::Pick(11));
        assert_eq!(input_for_control("v3_wheel_down", false), Input::Next);
        assert_eq!(input_for_control("v3_wheel_up", false), Input::Prev);
        assert_eq!(input_for_control("v3_wheel_click", false), Input::Confirm);
        assert_eq!(input_for_control("v3_wheel_left", false), Input::Back);
        assert_eq!(input_for_control("v3_top_aux_01", false), Input::Close);
        assert_eq!(input_for_control("v3_thumb_11", true), Input::Close, "the opener closes");
    }

    #[test]
    fn the_preview_shows_what_an_action_sends() {
        use crate::config::{ActionType, PasteMode, SequenceActionPayload, SnippetLibraryItem};
        let mut config = crate::config::default_seed_config();
        config.snippet_library.push(SnippetLibraryItem {
            id: "lib-1".into(),
            name: "Lib".into(),
            text: "  from the library  ".into(),
            paste_mode: PasteMode::SendText,
            tags: Vec::new(),
            notes: None,
        });
        let action = |payload| Action {
            id: "a".into(),
            action_type: ActionType::Sequence,
            payload,
            display_name: "a".into(),
            conditions: Vec::new(),
            notes: None,
        };
        let sequence = action(ActionPayload::Sequence(SequenceActionPayload {
            steps: vec![
                SequenceStep::Text { value: "продолжай".into(), delay_ms: None, repeat: None },
                SequenceStep::Sleep { delay_ms: 80 },
                SequenceStep::Send { value: "Enter".into(), delay_ms: None, repeat: None },
            ],
        }));
        assert_eq!(action_detail(&config, &sequence).as_deref(), Some("продолжай ⏎"));
        let library = action(ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id: "lib-1".into() }));
        assert_eq!(action_detail(&config, &library).as_deref(), Some("from the library"));
        let long = action(ActionPayload::TextSnippet(TextSnippetPayload::Inline {
            text: "x".repeat(DETAIL_CHARS + 50),
            paste_mode: PasteMode::SendText,
            tags: Vec::new(),
        }));
        assert_eq!(action_detail(&config, &long).map(|text| text.chars().count()), Some(DETAIL_CHARS + 1), "clipped with …");
    }

    #[test]
    fn every_item_carries_its_number() {
        let items = (0..14).map(|n| action(&n.to_string(), "x")).collect();
        let view = Model::new(items, HashMap::new()).view("t", 1);
        assert_eq!(view.items[0].number, Some(1));
        assert_eq!(view.items[11].number, Some(12));
        assert_eq!(view.items[12].number, Some(13), "numbered on, past the side buttons too");
    }
}
