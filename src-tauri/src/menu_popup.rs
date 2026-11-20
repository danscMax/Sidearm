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
    config::{Action, ActionPayload, ActionType, AppConfig, MenuActionPayload, MenuItem, SequenceStep, TextSnippetPayload},
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
    /// Item at this index of the level shown (a click on its row).
    Pick(usize),
    /// The item with this number (0-based), a side button's: lines between
    /// items have none, so it is no row index.
    Number(usize),
    Next,
    Prev,
    /// A row down / up: in a cheat sheet's grid the cell below / above, in a list one item.
    NextRow,
    PrevRow,
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
    /// Actions with text that Copy and Enter can use (a shortcut also has a detail).
    text_actions: HashSet<String>,
    /// What each action does, in the owner's words (its optional `notes`), by action id.
    notes: HashMap<String, String>,
    /// The other menus (action id, name, items): a search also looks there.
    others: Vec<(String, String, Vec<MenuItem>)>,
    /// Ids of menu actions: a link to another menu is no search result there.
    menu_ids: HashSet<String>,
    /// The search looks only in this menu, not in the others too.
    only_this: bool,
    /// A cheat sheet ([`Model::sheet`]): the cells' other press patterns. Its
    /// cells stay in place while typing: the ones that do not match are dimmed.
    grid: Option<Vec<Vec<String>>>,
    /// Links to other menus shown as submenus ([`Model::expand_links`]): the
    /// submenu's id → the linked menu's action id.
    links: HashMap<String, String>,
}

/// Cells per row of a cheat sheet's grid (the mouse's side buttons, 3 across).
const GRID_COLUMNS: usize = 3;

/// The text contains the needle (already lowercased) — also when it was typed
/// in the other keyboard layout: both sides compared as the keys pressed on a
/// ЙЦУКЕН/QWERTY keyboard.
fn text_hits(text: &str, needle: &str) -> bool {
    let keys = |text: &str| crate::hotkeys::normalize_cyrillic_key(text).to_lowercase();
    let text = text.to_lowercase();
    text.contains(needle) || keys(&text).contains(&keys(needle))
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
    /// A line between items (no label, no number).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub separator: bool,
    /// The search box's place among the top-level items (no label, no number).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub search: bool,
    pub enabled: bool,
    /// What it sends (text, keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub text: bool,
    /// What it does (the action's `notes`), shown on hover.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// For a submenu: the names of what it holds, drawn as a list in the tip.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
    pub text_children: Vec<bool>,
    /// For a link to another menu: each child's block heading (empty when none has one).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub child_groups: Vec<Option<String>>,
    /// For a submenu: each child's note (empty when none has one).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub child_notes: Vec<Option<String>>,
    /// The block heading it sits under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// A cheat sheet's cell: the button's other press patterns (mark + name).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extras: Vec<String>,
    /// A cheat sheet's cell that the typed query does not match.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dim: bool,
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
    /// Available physical height on the opening cursor's monitor, excluding the taskbar.
    pub max_height: u32,
    /// The search also looks in the other menus (the scope switch shows when there are any).
    pub search_all: bool,
    /// The menu has a search box (turned off in the editor: none, typing searches nothing).
    pub search_on: bool,
    /// Where the page draws the box: "top" (fixed above the rows), "bottom"
    /// (fixed below) or "row" (at the search row, among the rows). From the
    /// item's place in the top level: first → top, last → bottom, between →
    /// its row there; a list or the results keep the top or the bottom.
    pub search_place: &'static str,
    pub has_others: bool,
    /// The scope switch's two names, in the UI language.
    pub scope_all: String,
    pub scope_this: String,
    /// A cheat sheet: the side buttons drawn as the mouse's grid; typing dims
    /// the cells that do not match.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub grid: bool,
    /// A cheat sheet: the name of the layer Tab switches to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switch_layer: Option<String>,
}

/// A line is never enabled: it is not highlighted, hovered or picked.
fn item_enabled(item: &MenuItem) -> bool {
    match item {
        MenuItem::Action { enabled, .. } | MenuItem::Submenu { enabled, .. } => *enabled,
        MenuItem::Separator { .. } | MenuItem::Search { .. } => false,
    }
}

/// A row with a number (a side button picks it): not a line or the search box.
fn is_numbered(item: &MenuItem) -> bool {
    matches!(item, MenuItem::Action { .. } | MenuItem::Submenu { .. })
}

fn item_pinned(item: &MenuItem) -> bool {
    matches!(item, MenuItem::Action { pinned: true, .. })
}

fn item_label(item: &MenuItem) -> &str {
    match item {
        MenuItem::Action { label, .. } | MenuItem::Submenu { label, .. } => label,
        MenuItem::Separator { .. } | MenuItem::Search { .. } => "",
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
            text_actions: HashSet::new(),
            notes: HashMap::new(),
            others: Vec::new(),
            menu_ids: HashSet::new(),
            only_this: false,
            grid: None,
            links: HashMap::new(),
        };
        model.only_this = model.search_box().is_some_and(|(_, all, _)| !all);
        model.highlight = model.first_enabled().unwrap_or(0);
        model
    }

    /// A cheat sheet: `items` are the side buttons in order, drawn as a grid
    /// [`GRID_COLUMNS`] across, `extras` each cell's other press patterns.
    pub(crate) fn sheet(items: Vec<MenuItem>, details: HashMap<String, String>, extras: Vec<Vec<String>>) -> Self {
        let mut model = Self::new(items, details);
        model.grid = Some(extras);
        model
    }

    fn needle(&self) -> String {
        self.query.trim().to_lowercase()
    }

    /// The menu's search box item: (shows, starts in all menus, its index in the top level).
    fn search_box(&self) -> Option<(bool, bool, usize)> {
        let at = self.root.iter().position(|item| matches!(item, MenuItem::Search { .. }))?;
        let MenuItem::Search { enabled, all_menus, .. } = &self.root[at] else { return None };
        Some((*enabled, *all_menus, at))
    }

    /// [`View::search_place`]: the ★ block and disabled blocks do not move it,
    /// so the box stays at the same end on every level.
    fn search_place(&self) -> &'static str {
        match self.search_box() {
            Some((_, _, at)) if at + 1 == self.root.len() && at > 0 => "bottom",
            Some((_, _, at)) if at > 0 && self.path.is_empty() && self.needle().is_empty() => "row",
            _ => "top",
        }
    }

    /// Typing searches: a cheat sheet always, a menu unless its box is off.
    fn search_on(&self) -> bool {
        self.grid.is_some() || self.search_box().is_none_or(|(on, _, _)| on)
    }

    /// A cheat sheet's cell that does not match the typed query.
    fn dimmed(&self, index: usize, item: &MenuItem) -> bool {
        let Some(extras) = &self.grid else { return false };
        let needle = self.needle();
        !needle.is_empty()
            && !self.matches(item, &needle)
            && !extras.get(index).is_some_and(|extras| extras.iter().any(|extra| text_hits(extra, &needle)))
    }

    /// A row the highlight can land on: enabled, and in a grid not dimmed.
    fn selectable(&self, index: usize, item: &MenuItem) -> bool {
        item_enabled(item) && !self.dimmed(index, item)
    }

    fn selectable_at(&self, index: usize) -> bool {
        self.walk().0.get(index).is_some_and(|entry| self.selectable(index, entry.item))
    }

    /// The other menus a search also looks in (their details must be in the
    /// model's), and the ids of all menu actions.
    pub(crate) fn with_others(mut self, others: Vec<(String, String, Vec<MenuItem>)>, menu_ids: HashSet<String>) -> Self {
        self.others = others;
        self.menu_ids = menu_ids;
        self
    }

    /// Every item that opens another menu (`menus`: action id → items) becomes
    /// a submenu holding that menu's items (its search box left out), so it
    /// shows them in the tip and opens them in place, with the linked menu's
    /// blocks as headings. One list, many menus: the link always shows the
    /// current contents. `own` and any menu already on the way are not
    /// expanded again (no cycles); such a link keeps opening its menu.
    pub(crate) fn expand_links(mut self, own: Option<&str>, menus: &HashMap<String, Vec<MenuItem>>) -> Self {
        fn expand(items: &mut [MenuItem], menus: &HashMap<String, Vec<MenuItem>>, seen: &mut Vec<String>, links: &mut HashMap<String, String>) {
            for item in items.iter_mut() {
                let link = match item {
                    MenuItem::Submenu { items, .. } => {
                        expand(items, menus, seen, links);
                        None
                    }
                    MenuItem::Action { id, label, action_id, enabled, .. } if !seen.contains(action_id) => menus
                        .get(action_id)
                        .map(|target| (id.clone(), label.clone(), action_id.clone(), *enabled, target)),
                    _ => None,
                };
                let Some((id, label, action_id, enabled, target)) = link else { continue };
                let mut inner: Vec<MenuItem> = target.iter().filter(|inner| !matches!(inner, MenuItem::Search { .. })).cloned().collect();
                seen.push(action_id.clone());
                expand(&mut inner, menus, seen, links);
                seen.pop();
                links.insert(id.clone(), action_id);
                *item = MenuItem::Submenu { id, label, items: inner, enabled };
            }
        }
        let mut seen: Vec<String> = own.map(str::to_owned).into_iter().collect();
        expand(&mut self.root, menus, &mut seen, &mut self.links);
        self.highlight = self.first_enabled().unwrap_or(0);
        self
    }

    fn is_link(&self, item: &MenuItem) -> bool {
        matches!(item, MenuItem::Submenu { id, .. } if self.links.contains_key(id))
    }

    /// The rows of a level drawn as blocks: each enabled submenu (not a link)
    /// is a heading over its items; pinned items and a box turned off left out.
    fn blocks<'a>(&'a self, items: &'a [MenuItem], menu: Option<&'a str>) -> Vec<Entry<'a>> {
        let mut level = Vec::new();
        for item in items {
            match item {
                MenuItem::Submenu { label, items, enabled, .. } if !self.is_link(item) => {
                    if *enabled {
                        level.extend(
                            items
                                .iter()
                                .filter(|inner| !item_pinned(inner))
                                .map(|inner| Entry { item: inner, group: Some(label.as_str()), menu }),
                        );
                    }
                }
                _ if item_pinned(item) => {}
                MenuItem::Search { enabled: false, .. } => {}
                _ => level.push(Entry { item, group: None, menu }),
            }
        }
        level
    }

    /// The rows a submenu opens to: a link's as blocks, under its menu's id.
    fn level_of<'a>(&'a self, submenu: &'a MenuItem, menu: Option<&'a str>) -> Vec<Entry<'a>> {
        let MenuItem::Submenu { id, items, .. } = submenu else { return Vec::new() };
        match self.links.get(id) {
            Some(target) => self.blocks(items, Some(target.as_str())),
            None => items.iter().filter(|item| !item_pinned(item)).map(|item| Entry { item, group: None, menu }).collect(),
        }
    }

    /// A row's menu item id and, for a result from another menu, that menu's id.
    pub(crate) fn item_at(&self, index: usize) -> Option<(String, Option<String>)> {
        let (level, _) = self.walk();
        let entry = level.get(index)?;
        let id = match entry.item {
            MenuItem::Action { id, .. } | MenuItem::Submenu { id, .. } | MenuItem::Separator { id } | MenuItem::Search { id, .. } => id.clone(),
        };
        Some((id, entry.menu.map(str::to_owned)))
    }

    /// `item_at` of a row inside the submenu at `index` of the level shown
    /// (a name in its tip), without opening it.
    pub(crate) fn child_item_at(&mut self, index: usize, child: usize) -> Option<(String, Option<String>)> {
        if !matches!(self.walk().0.get(index)?.item, MenuItem::Submenu { .. }) {
            return None;
        }
        self.path.push(index);
        let found = self.item_at(child);
        self.path.pop();
        found
    }

    /// The action of a row of the level shown.
    pub(crate) fn action_at(&self, index: usize) -> Option<String> {
        match self.walk().0.get(index)?.item {
            MenuItem::Action { action_id, .. } => Some(action_id.clone()),
            MenuItem::Submenu { .. } | MenuItem::Separator { .. } | MenuItem::Search { .. } => None,
        }
    }

    /// The name or the sent text contains the query — also when it was typed
    /// in the other keyboard layout ("ghbyz" finds "Принял", "руддщ" "hello"):
    /// both sides compared as the keys pressed on a ЙЦУКЕН/QWERTY keyboard.
    /// How well `item` matches: 0 its name starts with the query, 1 its name
    /// holds it, 2 only its text does (the same layout-insensitive comparison).
    fn rank(item: &MenuItem, needle: &str) -> u8 {
        let MenuItem::Action { label, .. } = item else { return 2 };
        let keys = |text: &str| crate::hotkeys::normalize_cyrillic_key(text).to_lowercase();
        let (label, label_keys, needle_keys) = (label.to_lowercase(), keys(label), keys(needle));
        if label.starts_with(needle) || label_keys.starts_with(&needle_keys) {
            0
        } else if label.contains(needle) || label_keys.contains(&needle_keys) {
            1
        } else {
            2
        }
    }

    /// Search only this menu (`true`) or the others too.
    pub(crate) fn set_scope(&mut self, only_this: bool) {
        self.only_this = only_this;
        self.highlight = self.first_enabled().unwrap_or(0);
    }

    fn matches(&self, item: &MenuItem, needle: &str) -> bool {
        let MenuItem::Action { label, action_id, .. } = item else { return false };
        text_hits(label, needle)
            || self.details.get(action_id).is_some_and(|text| text_hits(text, needle))
            || self.notes.get(action_id).is_some_and(|text| text_hits(text, needle))
    }

    /// The rows shown and the labels of the submenus opened to get there.
    fn walk(&self) -> (Vec<Entry<'_>>, Vec<&str>) {
        let needle = self.needle();
        // A grid keeps its cells where they are; `dimmed` marks the misses.
        if !needle.is_empty() && self.grid.is_none() {
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
                        // A linked menu is searched as itself, under its own name.
                        MenuItem::Submenu { .. } if state.model.is_link(item) => {}
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
            if !self.only_this {
                for (id, name, items) in &self.others {
                    search(&mut state, items, Some(name), Some((id, name)));
                }
            }
            // Names before texts, but only within a group: a sort across them would
            // split a block or menu into several headings. Stable: ties keep the tree order.
            let mut found = state.found;
            let mut start = 0;
            while start < found.len() {
                let (group, menu) = (found[start].group, found[start].menu);
                let end = start + found[start..].iter().take_while(|entry| entry.group == group && entry.menu == menu).count();
                found[start..end].sort_by_key(|entry| Self::rank(entry.item, &needle));
                start = end;
            }
            return (found, Vec::new());
        }
        // Pinned items first, in their own block, and only there.
        let mut level: Vec<Entry<'_>> = Vec::new();
        fn pinned<'a>(model: &Model, items: &'a [MenuItem], level: &mut Vec<Entry<'a>>) {
            for item in items.iter().filter(|item| item_enabled(item)) {
                match item {
                    // A linked menu's pinned items belong to its own ★ block.
                    MenuItem::Submenu { .. } if model.is_link(item) => {}
                    MenuItem::Submenu { items, .. } => pinned(model, items, level),
                    _ if item_pinned(item) => level.push(Entry { item, group: Some(PINNED), menu: None }),
                    _ => {}
                }
            }
        }
        pinned(self, &self.root, &mut level);
        level.extend(self.blocks(&self.root, None));
        let mut labels = Vec::new();
        for &index in &self.path {
            match level.get(index) {
                Some(&Entry { item: submenu @ MenuItem::Submenu { label, .. }, menu, .. }) => {
                    labels.push(label.as_str());
                    level = self.level_of(submenu, menu);
                }
                _ => return (Vec::new(), labels),
            }
        }
        (level, labels)
    }

    /// The first row the highlight can land on; in a filtered grid the best
    /// match (`rank`), ties in grid order.
    fn first_enabled(&self) -> Option<usize> {
        let needle = self.needle();
        let ranked = self.grid.is_some() && !needle.is_empty();
        self.walk()
            .0
            .iter()
            .enumerate()
            .filter(|(index, entry)| self.selectable(*index, entry.item))
            .min_by_key(|(index, entry)| (if ranked { Self::rank(entry.item, &needle) } else { 0 }, *index))
            .map(|(index, _)| index)
    }

    /// The selectable row one step away from the highlight, wrapping.
    fn step(&self, forward: bool) -> usize {
        let (level, _) = self.walk();
        let len = level.len();
        let mut index = self.highlight.min(len.saturating_sub(1));
        for _ in 0..len {
            index = if forward { (index + 1) % len } else { (index + len - 1) % len };
            if self.selectable(index, level[index].item) {
                return index;
            }
        }
        self.highlight
    }

    /// A row down / up: in a grid the next selectable cell of the same column
    /// (wrapping), in a list one step.
    fn step_row(&self, down: bool) -> usize {
        if self.grid.is_none() {
            return self.step(down);
        }
        let (level, _) = self.walk();
        let len = level.len();
        if len == 0 {
            return self.highlight;
        }
        let start = self.highlight.min(len - 1);
        let (row, column) = (start / GRID_COLUMNS, start % GRID_COLUMNS);
        let rows = len.div_ceil(GRID_COLUMNS);
        for k in 1..rows {
            let next = if down { (row + k) % rows } else { (row + rows - k) % rows };
            let index = next * GRID_COLUMNS + column;
            if index < len && self.selectable(index, level[index].item) {
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
            MenuItem::Separator { .. } | MenuItem::Search { .. } => Step::Stay,
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
            Input::Number(number) => match self.row_of_number(number) {
                Some(index) => self.take(index),
                None => Step::Stay,
            },
            // Not a dimmed cell, nor one left highlighted when nothing matches.
            Input::Confirm if !self.selectable_at(self.highlight) => Step::Stay,
            Input::Confirm => self.take(self.highlight),
            Input::Next | Input::Prev => {
                self.highlight = self.step(input == Input::Next);
                Step::Stay
            }
            Input::NextRow | Input::PrevRow => {
                self.highlight = self.step_row(input == Input::NextRow);
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

    /// Typing in the search box: results from the whole tree, best first; in a
    /// grid the best matching cell (none highlighted when nothing matches).
    pub(crate) fn set_query(&mut self, query: &str) {
        if !self.search_on() {
            return;
        }
        self.query = query.to_owned();
        self.path.clear();
        let none = if self.grid.is_some() { self.walk().0.len() } else { 0 };
        self.highlight = self.first_enabled().unwrap_or(none);
    }

    /// Highlight a row under the mouse pointer (ignored when disabled or dimmed).
    pub(crate) fn hover(&mut self, index: usize) -> bool {
        if self.selectable_at(index) && self.highlight != index {
            self.highlight = index;
            return true;
        }
        false
    }

    /// The row of item `number` (0-based) of the level shown: lines are skipped.
    fn row_of_number(&self, number: usize) -> Option<usize> {
        self.walk().0.iter().enumerate().filter(|(_, entry)| is_numbered(entry.item)).nth(number).map(|(index, _)| index)
    }

    fn note_of(&self, item: &MenuItem) -> Option<String> {
        let MenuItem::Action { action_id, .. } = item else { return None };
        self.notes.get(action_id).map(|text| clip(text))
    }

    pub(crate) fn view(&self, title: &str, generation: u64) -> View {
        let (level, labels) = self.walk();
        let mut numbered = 0;
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
                    number: is_numbered(entry.item).then(|| {
                        numbered += 1;
                        numbered
                    }),
                    separator: matches!(entry.item, MenuItem::Separator { .. }),
                    search: matches!(entry.item, MenuItem::Search { .. }),
                    submenu: matches!(entry.item, MenuItem::Submenu { .. }),
                    enabled: item_enabled(entry.item),
                    detail: match entry.item {
                        MenuItem::Action { action_id, .. } => self.details.get(action_id).map(|text| clip(text)),
                        MenuItem::Submenu { .. } | MenuItem::Separator { .. } | MenuItem::Search { .. } => None,
                    },
                    text: matches!(entry.item, MenuItem::Action { action_id, .. } if self.text_actions.contains(action_id)),
                    note: self.note_of(entry.item),
                    // The rows its level shows (pinned ones live in the ★ block).
                    children: self.level_of(entry.item, entry.menu).iter().map(|child| item_label(child.item).to_owned()).collect(),
                    text_children: self.level_of(entry.item, entry.menu).iter().map(|child| {
                        matches!(child.item, MenuItem::Action { action_id, .. } if self.text_actions.contains(action_id))
                    }).collect(),
                    child_groups: {
                        let groups: Vec<Option<String>> = self.level_of(entry.item, entry.menu).iter().map(|child| child.group.map(str::to_owned)).collect();
                        if groups.iter().any(Option::is_some) { groups } else { Vec::new() }
                    },
                    child_notes: {
                        let notes: Vec<Option<String>> = self.level_of(entry.item, entry.menu).iter().map(|child| self.note_of(child.item)).collect();
                        if notes.iter().any(Option::is_some) { notes } else { Vec::new() }
                    },
                    group: entry.group.map(str::to_owned),
                    extras: self.grid.as_ref().and_then(|extras| extras.get(index).cloned()).unwrap_or_default(),
                    dim: self.dimmed(index, entry.item),
                })
                .collect(),
            highlight: self.highlight,
            query: self.query.clone(),
            placeholder: String::new(),
            empty: String::new(),
            pick_modes: Vec::new(),
            generation,
            max_height: u32::MAX,
            search_all: !self.only_this,
            search_on: self.search_on(),
            search_place: self.search_place(),
            has_others: !self.others.is_empty() && self.search_on(),
            scope_all: String::new(),
            scope_this: String::new(),
            grid: self.grid.is_some(),
            switch_layer: None,
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
        ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id, .. }) => {
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
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
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
        return Input::Number(number - 1);
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
    max_height: u32,
    /// Where the list stays and which side the tip takes, fixed by the first layout.
    placement: Option<Placement>,
    /// A cheat sheet ([`open_sheet`]): the profile and layer shown.
    sheet: Option<(String, crate::config::Layer)>,
}

/// The layer Tab switches a cheat sheet to: standard ↔ HyperShift (a
/// HyperShift 2 sheet goes to standard).
fn other_layer(layer: crate::config::Layer) -> crate::config::Layer {
    use crate::config::Layer;
    if layer == Layer::Standard { Layer::Hypershift } else { Layer::Standard }
}

/// A cheat sheet's model and title: the 12 side buttons of the mouse `control`
/// is on, on `layer`.
fn sheet_model(config: &AppConfig, profile: &str, control: Option<&str>, layer: crate::config::Layer) -> (Model, String) {
    let (items, extras) = crate::cheatsheet::sheet_items(config, profile, control, layer);
    let details = menu_details(config, &items);
    let mut model = Model::sheet(items, details, extras);
    model.text_actions = config.actions.iter().filter(|action| full_text(config, &action.id).is_some()).map(|action| action.id.clone()).collect();
    (model, crate::cheatsheet::layer_title(config, profile, layer))
}

static OPEN: Mutex<Option<OpenMenu>> = Mutex::new(None);
static IS_OPEN: AtomicBool = AtomicBool::new(false);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The menu whose first layout came at the wrong scale (`page_layout`).
static DEFERRED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The menu last sized and shown by `page_layout`.
static SHOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    let linked: HashMap<String, Vec<MenuItem>> = menus.iter().map(|(action, menu)| (action.id.clone(), menu.items.clone())).collect();
    let mut model = Model::new(payload.items.clone(), menu_details(config, &all_items))
        .with_others(others, menu_ids)
        .expand_links(preview.action_id.as_deref(), &linked);
    model.text_actions = config.actions.iter().filter(|action| full_text(config, &action.id).is_some()).map(|action| action.id.clone()).collect();
    model.notes = action_notes(config);
    open_model(app, runtime_store, config, preview, title, model, is_fg_elevated, None);
}

/// Open the popup for a resolved `cheatSheet` action: the pressed mouse's 12
/// side buttons on `layer` as a grid; side button N, a click or Enter runs
/// that button's action of the layer shown (the opening button closes it).
pub(crate) fn open_sheet(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &ResolvedInputPreview,
    layer: crate::config::Layer,
    is_fg_elevated: bool,
) {
    let profile = preview.resolved_profile_id.clone().unwrap_or_else(|| config.settings.fallback_profile_id.clone());
    let (model, title) = sheet_model(config, &profile, preview.control_id.as_deref(), layer);
    open_model(app, runtime_store, config, preview, &title, model, is_fg_elevated, Some((profile, layer)));
}

/// Tab in a cheat sheet: the same sheet on the other layer ([`other_layer`]),
/// in the same popup (same opening button); the typed query stays.
pub(crate) fn switch_sheet_layer_from_window(app: &AppHandle) {
    let mut guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(menu) = guard.as_mut() else { return };
    let Some((profile, layer)) = menu.sheet.clone() else { return };
    let layer = other_layer(layer);
    let (mut model, title) = sheet_model(&menu.config, &profile, menu.opener_control.as_deref(), layer);
    model.set_query(&menu.model.query);
    (menu.model, menu.title, menu.sheet) = (model, title, Some((profile, layer)));
    let view = view_of(menu);
    drop(guard);
    log::info!("[menu] cheat sheet switched to {layer:?}");
    if !crate::fake_mode() || crate::fake_popups() {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, &view);
    }
}

#[allow(clippy::too_many_arguments)]
fn open_model(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &ResolvedInputPreview,
    title: &str,
    model: Model,
    is_fg_elevated: bool,
    sheet: Option<(String, crate::config::Layer)>,
) {
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let anchor = platform::cursor_position();
    let max_height = app.monitor_from_point(f64::from(anchor.0), f64::from(anchor.1)).ok().flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .map_or(600, |monitor| monitor.work_area().size.height);
    let menu = OpenMenu {
        model,
        title: title.to_owned(),
        generation,
        opener_control: preview.control_id.clone(),
        preview: preview.clone(),
        config: Arc::new(config.clone()),
        runtime_store: runtime_store.clone(),
        is_fg_elevated,
        target_window: platform::foreground_window(),
        anchor,
        max_height,
        placement: None,
        sheet,
    };
    let view = view_of(&menu);
    let anchor = menu.anchor;
    *OPEN.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(menu);
    IS_OPEN.store(true, Ordering::Release);
    // The numbered rows: no line, no search box.
    log::info!("[menu] opened `{title}` ({} items)", view.items.iter().filter(|item| item.number.is_some()).count());
    if crate::fake_mode() && !crate::fake_popups() {
        return; // A test run has no windows; the model still answers presses.
    }
    show(app, &view, anchor);
    platform::spawn_watch(app.clone(), generation);
}

/// The open menu's [`View`], with the page's texts in the UI language.
fn view_of(menu: &OpenMenu) -> View {
    let mut view = menu.model.view(&menu.title, menu.generation);
    view.max_height = menu.max_height;
    if let Some((_, layer)) = menu.sheet {
        view.switch_layer = Some(crate::cheatsheet::layer_name(other_layer(layer)));
    }
    view.placeholder = crate::ui_text::native(&crate::ui_text!("menu.searchPlaceholder", "Search phrases…"));
    view.scope_all = crate::ui_text::native(&crate::ui_text!("menu.scopeAll", "All menus"));
    view.scope_this = crate::ui_text::native(&crate::ui_text!("menu.scopeThis", "This menu"));
    view.empty = crate::ui_text::native(&crate::ui_text!("menu.noResults", "Nothing found"));
    view.pick_modes = vec![
        crate::ui_text::native(&crate::ui_text!("menu.pickRun", "Insert")),
        crate::ui_text::native(&crate::ui_text!("menu.pickEnter", "Insert and press Enter")),
        crate::ui_text::native(&crate::ui_text!("menu.pickCopy", "Only copy to the clipboard")),
        crate::ui_text::native(&crate::ui_text!("menu.pickEdit", "Edit in Sidearm")),
    ];
    view
}

/// Every action's non-empty `notes` (a placeholder's says nothing about a menu item).
fn action_notes(config: &AppConfig) -> HashMap<String, String> {
    config
        .actions
        .iter()
        .filter(|action| action.action_type != ActionType::Disabled)
        .filter_map(|action| {
            let note = action.notes.as_deref()?.trim();
            (!note.is_empty()).then(|| (action.id.clone(), note.to_owned()))
        })
        .collect()
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
            MenuItem::Separator { .. } | MenuItem::Search { .. } => {}
        }
    }
    details
}

fn show(app: &AppHandle, view: &View, anchor: (i32, i32)) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        // The page asks for the view once loaded (`menu_ready`). No window, no
        // menu: an invisible one would swallow the buttons.
        if !create_window(app, anchor) {
            close(app);
        }
        return;
    };
    move_hidden(&window, anchor);
    let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOW, view);
}

/// Put the popup on the cursor's monitor before the page measures itself, as
/// a 1×1 transparent window that takes no focus: a hidden window keeps the
/// scale of the monitor it was last shown on (measured 2026-11-13: moved while
/// hidden, it stayed at 2.25 on a 1.0 monitor), so the page measured at the
/// wrong scale and the menu showed oversized, then jumped.
fn move_hidden(window: &tauri::WebviewWindow, anchor: (i32, i32)) {
    platform::park_at(window, anchor);
}

fn create_window(app: &AppHandle, anchor: (i32, i32)) -> bool {
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
            move_hidden(&window, anchor);
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
        ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { snippet_id, .. }) => {
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

fn copy_pick(config: &AppConfig, action_id: &str, mode: PickMode, copy: impl FnOnce(String)) -> bool {
    if mode != PickMode::Copy {
        return false;
    }
    match full_text(config, action_id) {
        Some(text) => copy(text),
        None => log::warn!("[menu] Copy skipped: `{action_id}` has no text"),
    }
    true
}

pub(crate) fn finish_pick(mode: PickMode, succeeded: bool, enter: impl FnOnce()) {
    if mode == PickMode::Enter && succeeded {
        enter();
    }
}

/// "Insert and Enter" on an action that already ends with Enter (a phrase's
/// `pressEnter`, a sequence whose last input is Enter) only runs it: a second
/// Enter would submit twice.
fn pick_mode_for(config: &AppConfig, action_id: &str, mode: PickMode) -> PickMode {
    let presses_enter = config.actions.iter().find(|action| action.id == action_id).is_some_and(|action| match &action.payload {
        ActionPayload::TextSnippet(payload) => payload.press_enter(),
        ActionPayload::Sequence(payload) => payload
            .steps
            .iter()
            .rev()
            .find(|step| !matches!(step, SequenceStep::Sleep { .. }))
            .is_some_and(|step| matches!(step, SequenceStep::Send { value, .. } if value.eq_ignore_ascii_case("enter"))),
        _ => false,
    });
    if mode == PickMode::Enter && presses_enter { PickMode::Run } else { mode }
}

fn layout_height(height: f64, max_height: u32) -> u32 {
    height.ceil().max(1.0).min(f64::from(max_height.max(1))) as u32
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
            if !crate::fake_mode() || crate::fake_popups() {
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
            if copy_pick(&menu.config, &action_id, mode, |text| {
                crate::press_log::count(None, &action_id);
                // What it would type: tokens filled in, the {cursor} marker gone.
                let text = crate::input_synthesis::expand_snippet_tokens(&text).0;
                if !crate::fake_mode()
                    && let Err(error) = crate::input_synthesis::clipboard_set_text(&text)
                {
                    log::warn!("[menu] could not copy `{action_id}`: {error}");
                }
            }) {
                return;
            }
            let target_window = menu.target_window;
            let mode = pick_mode_for(&menu.config, &action_id, mode);
            // Off the thread that got the pick: a click or Enter in the page comes
            // in on the main thread, which must not type a phrase (the window,
            // tray and popups would freeze meanwhile, and a window built there deadlocks).
            let app = app.clone();
            let _ = std::thread::Builder::new().name("menu-pick".into()).spawn(move || crate::capture_backend::run_menu_item(
                &app,
                &menu.runtime_store,
                &menu.config,
                &menu.preview,
                &action_id,
                menu.is_fg_elevated,
                move |succeeded| finish_pick(mode, succeeded, || {
                    if !crate::fake_mode() {
                        // The same pause a phrase with Enter keeps before it.
                        std::thread::sleep(std::time::Duration::from_millis(80));
                        // Not into another window that came up meanwhile: it would submit there.
                        if target_window == 0 || platform::foreground_window() == target_window {
                            let _ = crate::input_synthesis::send_hotkey_string("Enter", &crate::hotkeys::HotkeyModifiers::default());
                        } else {
                            log::warn!("[menu] Enter skipped: the window in front changed while the text was typed");
                        }
                    }
                }),
            ));
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
pub(crate) fn edit_from_window(app: &AppHandle, index: usize, child: Option<usize>) {
    let request = {
        let mut guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(menu) = guard.as_mut() else { return };
        let found = match child {
            Some(child) => menu.model.child_item_at(index, child),
            None => menu.model.item_at(index),
        };
        let Some((item_id, other)) = found else { return };
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

pub(crate) fn pick_child_from_window(app: &AppHandle, index: usize, child: usize, mode: PickMode) {
    drive_as(app, mode, |model| model.pick_child(index, child));
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
/// The scope switch of the search box: this menu only, or the others too.
pub(crate) fn search_scope_from_window(app: &AppHandle, all: bool) {
    drive(app, |model| {
        model.set_scope(!all);
        Step::Stay
    });
}

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

/// A wheel tick or an arrow key in the page; `row`: ↑/↓, a row of a cheat sheet's grid.
pub(crate) fn wheel_from_window(app: &AppHandle, down: bool, row: bool) {
    let input = match (row, down) {
        (false, true) => Input::Next,
        (false, false) => Input::Prev,
        (true, true) => Input::NextRow,
        (true, false) => Input::PrevRow,
    };
    drive(app, |model| model.apply(input));
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

/// What the page measured, in physical pixels: the whole page, its tip
/// (`side`, the part beside the list), the tip's widest (`side_max`) and which
/// side of the list it is drawn on.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PageSize {
    pub width: f64,
    pub height: f64,
    pub side: f64,
    pub side_max: f64,
    pub side_left: bool,
}

/// Where the list stays while the menu is open and which side the tip opens
/// on. Like a native submenu: the parent stays put and the child opens where
/// it fits, so a tip widening (a long submenu in columns) never moves the list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placement {
    #[serde(skip)]
    menu_x: i32,
    #[serde(skip)]
    work: (i32, i32, i32, i32),
    side_left: bool,
    /// Physical width the tip has on its side, up to the work area's edge.
    room: i32,
}

impl Placement {
    /// The tip goes right of the list unless its widest does not fit there and
    /// the left has more room.
    fn pin(menu_x: i32, menu_w: i32, work: (i32, i32, i32, i32), side_max: i32) -> Self {
        let right = work.2 - (menu_x + menu_w);
        let left = menu_x - work.0;
        let side_left = right < side_max && left > right;
        Self { menu_x, work, side_left, room: if side_left { left } else { right }.max(0) }
    }

    /// The window's x for a page `width` wide whose tip is `side` wide; kept
    /// inside the work area (a tip wider than its room would leave it).
    fn window_x(&self, width: i32, side: i32) -> i32 {
        let x = if self.side_left { self.menu_x - side } else { self.menu_x };
        x.min(self.work.2 - width).max(self.work.0)
    }
}

/// The page measured itself in physical pixels: size it and put it at the cursor.
/// The list's place and the tip's side are fixed by the first layout; later
/// ones (the tip widening or narrowing) only resize around them. Returns the
/// placement for the page to draw the tip on its side (`None`: not placed).
pub(crate) fn page_layout(app: &AppHandle, generation: u64, size: PageSize) -> Option<Placement> {
    page_layout_as(app, generation, size, false)
}

/// `settle`: show with what the page sent even when its tip is on the wrong
/// side (the page did not measure again in time).
fn page_layout_as(app: &AppHandle, generation: u64, size: PageSize, settle: bool) -> Option<Placement> {
    let PageSize { width, height, .. } = size;
    let (anchor, max_height, pinned) = {
        let guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        match guard.as_ref() {
            Some(menu) if menu.generation == generation => (menu.anchor, menu.max_height, menu.placement),
            _ => return None, // A late layout of a menu already closed.
        }
    };
    let window = app.get_webview_window(WINDOW_LABEL)?;
    // The page sends its size in physical pixels (its own devicePixelRatio):
    // a fresh window still sitting on another monitor renders at that
    // monitor's scale, and multiplying by the target's scale cut the menu off.
    // The page measures again once the move changes its scale.
    let scale = platform::dpi_scale_at(anchor);
    // Still at another monitor's scale (the new one has not reached the page
    // yet): wait for the page to measure again instead of showing a wrong size —
    // once per menu, and at most 200 ms: then it shows with what it has (a menu
    // that never appears would hold the mouse's buttons).
    if let Ok(now) = window.scale_factor()
        && (now - scale).abs() > 0.01
        && DEFERRED.swap(generation, Ordering::AcqRel) != generation
    {
        log::info!("[menu] the popup is at scale {now}, the cursor's monitor at {scale}: waiting for the page");
        move_hidden(&window, anchor);
        let app = app.clone();
        let _ = std::thread::Builder::new().name("menu-layout-wait".into()).spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if SHOWN.load(Ordering::Acquire) != generation {
                log::warn!("[menu] the page did not measure again: its size rescaled to the monitor");
                // On the main thread like every other layout: a close queues its hide
                // behind it there, so a menu closed meanwhile never comes back.
                let handle = app.clone();
                let ratio = scale / now;
                let rescaled = PageSize { width: width * ratio, height: height * ratio, side: size.side * ratio, side_max: size.side_max * ratio, ..size };
                let _ = app.run_on_main_thread(move || {
                    page_layout_as(&handle, generation, rescaled, true);
                });
            }
        });
        return None;
    }
    let (w, h) = (width.ceil() as i32, layout_height(height, max_height) as i32);
    let side = (size.side.ceil() as i32).clamp(0, w);
    let gap = (6.0 * scale).round() as i32;
    let placement = match pinned {
        Some(placement) => placement,
        None => {
            // The list alone at the cursor, as the whole popup was before.
            let (menu_x, _) = platform::position_near(anchor, w - side, h, gap);
            let placement = Placement::pin(menu_x, w - side, platform::work_area_at(anchor), size.side_max.ceil() as i32);
            let mut guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
            match guard.as_mut() {
                Some(menu) if menu.generation == generation => menu.placement = Some(placement),
                _ => return None,
            }
            placement
        }
    };
    // Still hidden and the tip drawn on the other side: the page moves it and
    // measures again before the menu shows, so it never appears mirrored.
    if placement.side_left != size.side_left && !settle && SHOWN.load(Ordering::Acquire) != generation {
        return Some(placement);
    }
    SHOWN.store(generation, Ordering::Release);
    let (x, y) = (placement.window_x(w, side), platform::position_near(anchor, w, h, gap).1);
    // Position first so a cross-monitor DPI change settles before sizing (see `show_osd`).
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w as u32, height: h as u32 }));
    // Shown and focused right here, synchronously: Tauri's `show()` runs later
    // on its event thread, and a `set_focus()` before it lands does nothing
    // (the keys then went to the app under the popup — measured 2026-11-12).
    platform::show_focused(&window);
    log::info!("[menu] shown ({w}x{h})");
    Some(placement)
}

/// Whether the open menu (if any) is `generation`.
fn is_generation(generation: u64) -> bool {
    OPEN.lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .is_some_and(|menu| menu.generation == generation)
}

#[cfg(target_os = "windows")]
pub(crate) mod platform {
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

    pub(crate) use crate::platform::display::{cursor_position, dpi_scale_at, position_near, work_area_at};

    pub(crate) fn foreground_window() -> isize {
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
    pub(crate) fn show_focused(window: &tauri::WebviewWindow) {
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

    /// Move, size 1×1 and show without activating, in one call (no frame of
    /// the old menu at the old place): visible, the window takes the scale of
    /// the monitor it is on. Transparent and 1 px, it is not seen.
    pub(crate) fn park_at(window: &tauri::WebviewWindow, anchor: (i32, i32)) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowPos};
        let Ok(hwnd) = window.hwnd() else { return };
        unsafe {
            SetWindowPos(hwnd.0 as HWND, std::ptr::null_mut(), anchor.0, anchor.1, 1, 1, SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
        }
    }

    /// Hidden the way it was shown (Tauri's own state never saw it shown).
    pub(crate) fn hide_window(window: &tauri::WebviewWindow) {
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
    pub(crate) fn restore_foreground(target: isize) {
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
    pub(crate) fn spawn_watch(app: AppHandle, generation: u64) {
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
pub(crate) mod platform {
    use tauri::AppHandle;

    pub(crate) fn foreground_window() -> isize {
        0
    }
    pub(crate) fn cursor_position() -> (i32, i32) {
        (100, 100)
    }
    pub(crate) fn dpi_scale_at(_: (i32, i32)) -> f64 {
        1.0
    }
    pub(crate) fn position_near(point: (i32, i32), _: i32, _: i32, gap: i32) -> (i32, i32) {
        (point.0 + gap, point.1 + gap)
    }
    pub(crate) fn work_area_at(_: (i32, i32)) -> (i32, i32, i32, i32) {
        (0, 0, 1920, 1080)
    }
    pub(crate) fn restore_foreground(_: isize) {}
    pub(crate) fn show_focused(window: &tauri::WebviewWindow) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    pub(crate) fn hide_window(window: &tauri::WebviewWindow) {
        let _ = window.hide();
    }
    pub(crate) fn park_at(window: &tauri::WebviewWindow, anchor: (i32, i32)) {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: anchor.0, y: anchor.1 }));
    }
    pub(crate) fn spawn_watch(_: AppHandle, _: u64) {}
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
        // Right click → Edit on that name finds its item and leaves the level as it was.
        let mut model = sample();
        let (id, other) = model.child_item_at(4, 0).expect("the child's item");
        assert_eq!((id.as_str(), other), ("x", None));
        assert_eq!(labels(&model.view("Phrases", 1)), labels(&sample().view("Phrases", 1)));
        assert_eq!(model.child_item_at(0, 0), None);
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
    fn the_search_item_places_the_box_sets_its_scope_and_can_turn_it_off() {
        let search = |enabled, all_menus| MenuItem::Search { id: "find".into(), enabled, all_menus };
        let other = || vec![("menu-2".to_owned(), "Work".to_owned(), vec![action("w", "Polish")])];
        // Between two items: its own row, no number, never picked; the numbers go on.
        let mut model = Model::new(vec![action("a", "A"), search(true, false), action("b", "B")], HashMap::new()).with_others(other(), HashSet::new());
        let view = model.view("Phrases", 1);
        let rows: Vec<_> = view.items.iter().map(|item| (item.search, item.number)).collect();
        assert_eq!(rows, [(false, Some(1)), (true, None), (false, Some(2))]);
        assert!(view.search_on && view.search_place == "row" && !view.search_all, "starts in this menu only");
        assert_eq!(model.apply(Input::Number(1)), Step::Run("act-b".into()), "thumb 2 is the second item, the box skipped");
        assert_eq!(model.apply(Input::Pick(1)), Step::Stay);
        model.set_query("pol");
        assert_eq!(labels(&model.view("Phrases", 1)), Vec::<&str>::new(), "this menu only: Polish is in another one");

        // Last: the box goes below the rows, also in a list or the results.
        let mut model = Model::new(vec![action("a", "Polite"), search(true, true)], HashMap::new());
        model.set_query("pol");
        let view = model.view("Phrases", 1);
        assert!(view.search_place == "bottom" && view.search_all);
        assert_eq!(labels(&view), ["Polite"]);

        // First stays on top, also under the ★ block (its row comes after the pinned ones).
        let pinned = MenuItem::Action { id: "p".into(), label: "P".into(), action_id: "act-p".into(), enabled: true, pinned: true };
        let model = Model::new(vec![search(true, true), action("a", "A"), pinned], HashMap::new());
        assert_eq!(model.view("Phrases", 1).search_place, "top");

        // Off: no row, typing searches nothing, Tab has nothing to switch.
        let mut model = Model::new(vec![search(false, true), action("a", "Polite")], HashMap::new()).with_others(other(), HashSet::new());
        model.set_query("pol");
        let view = model.view("Phrases", 1);
        assert!(!view.search_on && !view.has_others && view.query.is_empty());
        assert_eq!(view.items.len(), 1);
        assert_eq!(view.items[0].number, Some(1));
    }

    #[test]
    fn a_line_has_no_number_and_is_never_picked() {
        let line = MenuItem::Separator { id: "line".into() };
        let mut model = Model::new(
            vec![action("a", "A"), line.clone(), submenu("g", "Group", vec![action("b", "B"), line, action("c", "C")])],
            HashMap::new(),
        );
        let view = model.view("Phrases", 1);
        let numbers: Vec<_> = view.items.iter().map(|item| (item.separator, item.number)).collect();
        assert_eq!(numbers, [(false, Some(1)), (true, None), (false, Some(2)), (true, None), (false, Some(3))]);
        assert_eq!(model.apply(Input::Number(2)), Step::Run("act-c".into()), "thumb 3 is the third item, lines skipped");
        assert_eq!(model.apply(Input::Pick(1)), Step::Stay, "a click on a line does nothing");
        assert!(!model.hover(1));
        model.apply(Input::Next);
        assert_ne!(model.view("Phrases", 1).highlight, 1, "the wheel steps over a line");
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
    fn search_ranks_names_above_texts_within_a_group_and_can_stay_in_this_menu() {
        let items = vec![action("a", "Reply politely"), action("b", "Polite"), action("c", "Thanks")];
        let details: HashMap<String, String> = [("act-c".to_owned(), "very polite text".to_owned())].into();
        let other = vec![("menu-2".to_owned(), "Work".to_owned(), vec![action("w", "Polish")])];
        let mut model = Model::new(items, details).with_others(other, HashSet::new());
        model.set_query("pol");
        assert_eq!(labels(&model.view("Phrases", 1)), ["Polite", "Reply politely", "Thanks", "Polish"],
            "name start, then name, then text; another menu stays its own group");
        model.set_scope(true);
        let view = model.view("Phrases", 1);
        assert_eq!(labels(&view), ["Polite", "Reply politely", "Thanks"], "this menu only");
        assert!(!view.search_all && view.has_others);
    }

    #[test]
    fn controls_map_to_menu_inputs() {
        assert_eq!(input_for_control("v3_thumb_05", false), Input::Number(4));
        assert_eq!(input_for_control("thumb_12", false), Input::Number(11));
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
        let library = action(ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { press_enter: false, snippet_id: "lib-1".into() }));
        assert_eq!(action_detail(&config, &library).as_deref(), Some("from the library"));
        let long = action(ActionPayload::TextSnippet(TextSnippetPayload::Inline { press_enter: false,
            text: "x".repeat(DETAIL_CHARS + 50),
            paste_mode: PasteMode::SendText,
            tags: Vec::new(),
        }));
        assert_eq!(action_detail(&config, &long).map(|text| clip(&text).chars().count()), Some(DETAIL_CHARS + 1), "clipped with …");
    }

    #[test]
    fn every_item_carries_its_number() {
        let items = (0..14).map(|n| action(&n.to_string(), "x")).collect();
        let view = Model::new(items, HashMap::new()).view("t", 1);
        assert_eq!(view.items[0].number, Some(1));
        assert_eq!(view.items[11].number, Some(12));
        assert_eq!(view.items[12].number, Some(13), "numbered on, past the side buttons too");
    }

    #[test]
    fn copy_of_non_text_never_falls_through_to_execution() {
        let mut config = crate::config::default_seed_config();
        let mut action = config.actions[0].clone();
        action.id = "no-text".into();
        for payload in [
            ActionPayload::Shortcut(crate::config::ShortcutActionPayload { key: "W".into(), ctrl: true, shift: false, alt: false, win: false, raw: None }),
            ActionPayload::Sequence(crate::config::SequenceActionPayload { steps: vec![SequenceStep::Send { value: "Enter".into(), delay_ms: None, repeat: None }] }),
        ] {
            action.payload = payload;
            config.actions.push(action.clone());
            let mut ran = false;
            if !copy_pick(&config, &action.id, PickMode::Copy, |_| panic!("no text to copy")) { ran = true; }
            assert!(!ran, "Copy must consume the pick even without text");
            config.actions.pop();
        }
        assert!(copy_pick(&config, "missing-action", PickMode::Copy, |_| panic!("missing action")));
    }

    #[test]
    fn extra_enter_requires_successful_execution() {
        let mut enters = 0;
        finish_pick(PickMode::Enter, false, || enters += 1);
        assert_eq!(enters, 0, "failure before text must not submit existing input");
        finish_pick(PickMode::Enter, true, || enters += 1);
        assert_eq!(enters, 1);
        finish_pick(PickMode::Run, true, || enters += 1);
        finish_pick(PickMode::Copy, true, || enters += 1);
        assert_eq!(enters, 1);
    }

    #[test]
    fn insert_and_enter_on_an_action_that_already_presses_enter_sends_no_second_enter() {
        use crate::config::{PasteMode, SequenceActionPayload};
        let mut config = crate::config::default_seed_config();
        let template = config.actions[0].clone();
        let add = |config: &mut AppConfig, id: &str, payload| {
            let mut action = template.clone();
            action.id = id.into();
            action.payload = payload;
            config.actions.push(action);
        };
        let inline = |press_enter| ActionPayload::TextSnippet(TextSnippetPayload::Inline { press_enter, text: "ok".into(), paste_mode: PasteMode::SendText, tags: Vec::new() });
        add(&mut config, "with-enter", inline(true));
        add(&mut config, "plain", inline(false));
        add(&mut config, "lib-enter", ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { press_enter: true, snippet_id: "x".into() }));
        add(&mut config, "seq-enter", ActionPayload::Sequence(SequenceActionPayload { steps: vec![
            SequenceStep::Text { value: "ok".into(), delay_ms: None, repeat: None },
            SequenceStep::Send { value: "Enter".into(), delay_ms: None, repeat: None },
            SequenceStep::Sleep { delay_ms: 50 },
        ] }));
        add(&mut config, "seq-text", ActionPayload::Sequence(SequenceActionPayload { steps: vec![
            SequenceStep::Send { value: "Enter".into(), delay_ms: None, repeat: None },
            SequenceStep::Text { value: "ok".into(), delay_ms: None, repeat: None },
        ] }));
        for id in ["with-enter", "lib-enter", "seq-enter"] {
            assert_eq!(pick_mode_for(&config, id, PickMode::Enter), PickMode::Run, "{id} already presses Enter");
        }
        for id in ["plain", "seq-text", "missing"] {
            assert_eq!(pick_mode_for(&config, id, PickMode::Enter), PickMode::Enter, "{id} gets the popup's Enter");
        }
        assert_eq!(pick_mode_for(&config, "with-enter", PickMode::Copy), PickMode::Copy);
    }

    /// A cheat sheet of 12 cells: cells 2 and 5 (0-based 1, 4) are empty buttons.
    fn sheet() -> Model {
        let items = (1..=12)
            .map(|n| MenuItem::Action {
                id: format!("sheet-{n}"),
                label: match n { 1 => "Copy".into(), 7 => "Paste".into(), 9 => "Принять".into(), 2 | 5 => String::new(), _ => format!("Cell {n}") },
                action_id: format!("act-{n}"),
                enabled: n != 2 && n != 5,
                pinned: false,
            })
            .collect();
        let mut extras = vec![Vec::new(); 12];
        extras[10] = vec!["●● Screenshot".to_owned()];
        let details = HashMap::from([("act-4".to_owned(), "git status".to_owned())]);
        Model::sheet(items, details, extras)
    }

    #[test]
    fn a_cheat_sheet_moves_by_rows_and_cells_and_skips_empty_buttons() {
        let mut model = sheet();
        assert_eq!(model.highlight, 0);
        model.apply(Input::NextRow);
        assert_eq!(model.highlight, 3, "↓ is the cell below");
        model.apply(Input::NextRow);
        assert_eq!(model.highlight, 6);
        model.apply(Input::NextRow);
        model.apply(Input::NextRow);
        assert_eq!(model.highlight, 0, "wraps to the top of the column");
        model.apply(Input::PrevRow);
        assert_eq!(model.highlight, 9, "↑ from the top row wraps to the bottom");
        model.apply(Input::Next);
        assert_eq!(model.highlight, 10, "→ is the next cell");
        model.highlight = 0;
        model.apply(Input::Next);
        assert_eq!(model.highlight, 2, "→ steps over an empty button");
        model.highlight = 7; // the middle column, third row
        model.apply(Input::PrevRow);
        assert_eq!(model.highlight, 10, "↑ steps over the empty cells 5 and 2 of the column, wrapping");
        let view = model.view("Sheet", 1);
        assert!(view.grid);
        assert_eq!(view.items[10].extras, ["●● Screenshot"]);
        // A list keeps its one-item steps for ↑↓.
        let mut list = sample();
        list.apply(Input::NextRow);
        assert_eq!(list.highlight, 2, "a list: the next enabled item");
        assert!(!list.view("Phrases", 1).grid);
    }

    #[test]
    fn typing_in_a_cheat_sheet_dims_the_cells_that_do_not_match() {
        let mut model = sheet();
        model.set_query("cell");
        let view = model.view("Sheet", 1);
        assert_eq!(view.items.len(), 12, "the cells stay in place");
        assert!(view.items[0].dim && !view.items[2].dim);
        assert_eq!(view.highlight, 2, "the first match");
        assert_eq!(view.query, "cell");
        model.apply(Input::Next);
        assert_eq!(model.highlight, 3, "→ steps over dimmed cells");
        model.set_query("past");
        assert_eq!(model.highlight, 6, "the name");
        assert_eq!(model.apply(Input::Confirm), Step::Run("act-7".into()), "Enter runs the match");
        let mut model = sheet();
        model.set_query("git");
        assert_eq!(model.highlight, 3, "what it sends");
        model.set_query("screen");
        assert_eq!(model.highlight, 10, "another press pattern of the button");
        model.set_query("ghbyznm");
        assert_eq!(model.highlight, 8, "typed in the other keyboard layout");
        model.set_query("Cell 1");
        assert_eq!(model.highlight, 9, "of equal matches the first in grid order");
        model.set_query("p");
        assert_eq!(model.highlight, 6, "a name starting with the query (Paste) before an earlier one holding it (Copy)");
        model.set_query("zzz");
        let view = model.view("Sheet", 1);
        assert!(view.items.iter().all(|item| item.dim));
        assert_eq!(view.highlight, 12, "nothing highlighted");
        assert_eq!(model.apply(Input::Confirm), Step::Stay, "Enter runs nothing");
        assert_eq!(model.apply(Input::Back), Step::Stay, "back clears the query first");
        assert!(model.view("Sheet", 1).items.iter().all(|item| !item.dim));
        assert_eq!(model.apply(Input::Number(3)), Step::Run("act-4".into()), "side button N still picks cell N");
    }

    #[test]
    fn tab_switches_a_cheat_sheet_between_standard_and_hypershift() {
        use crate::config::Layer;
        assert_eq!(other_layer(Layer::Standard), Layer::Hypershift);
        assert_eq!(other_layer(Layer::Hypershift), Layer::Standard);
        assert_eq!(other_layer(Layer::Hypershift2), Layer::Standard);
    }

    #[test]
    fn popup_height_is_bounded_by_the_physical_work_area() {
        assert_eq!(layout_height(2200.0, 1040), 1040);
        assert_eq!(layout_height(4950.0, 1040), 1040, "225 percent DPI");
        assert_eq!(layout_height(500.2, 1040), 501);
        assert_eq!(layout_height(-10.0, 1040), 1);
    }

    #[test]
    fn search_finds_text_beyond_the_preview_for_all_text_sources() {
        use crate::config::{PasteMode, SequenceActionPayload, SnippetLibraryItem};
        let mut config = crate::config::default_seed_config();
        let text = format!("{}suffix-needle", "я".repeat(650));
        config.snippet_library.push(SnippetLibraryItem { id: "long-lib".into(), name: "Library".into(), text: text.clone(), paste_mode: PasteMode::SendText, tags: Vec::new(), notes: None });
        for (index, payload) in [
            ActionPayload::TextSnippet(TextSnippetPayload::Inline { press_enter: false, text: text.clone(), paste_mode: PasteMode::SendText, tags: Vec::new() }),
            ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef { press_enter: false, snippet_id: "long-lib".into() }),
            ActionPayload::Sequence(SequenceActionPayload { steps: vec![SequenceStep::Text { value: text.clone(), delay_ms: None, repeat: None }] }),
        ].into_iter().enumerate() {
            let id = format!("act-long-{index}");
            let mut action = config.actions[0].clone();
            action.id = id;
            action.payload = payload;
            config.actions.push(action);
        }
        let items: Vec<_> = (0..3).map(|i| action(&format!("long-{i}"), "Neutral")).collect();
        let mut model = Model::new(items.clone(), menu_details(&config, &items));
        model.set_query("suffix-needle");
        let view = model.view("Menu", 1);
        assert_eq!(view.items.len(), 3);
        assert!(view.items.iter().all(|item| item.detail.as_ref().is_some_and(|text| text.chars().count() == DETAIL_CHARS + 1)));
    }

    #[test]
    fn a_link_to_another_menu_shows_that_menus_blocks_as_a_submenu() {
        let max = vec![
            MenuItem::Search { id: "menu-search".into(), enabled: true, all_menus: true },
            submenu("check", "Check", vec![action("v", "Validate")]),
            submenu("plan", "Plan", vec![action("n", "Next")]),
        ];
        // The other menu links back: not expanded again (no cycle).
        let back = MenuItem::Action { id: "back".into(), label: "Home".into(), action_id: "menu-home".into(), enabled: true, pinned: false };
        let max = [max, vec![back]].concat();
        let link = MenuItem::Action { id: "link".into(), label: "Max".into(), action_id: "menu-max".into(), enabled: true, pinned: false };
        let menus = HashMap::from([("menu-max".to_owned(), max), ("menu-home".to_owned(), Vec::new())]);
        let mut model = Model::new(vec![submenu("top", "Top", vec![action("a", "Ask"), link])], HashMap::new())
            .expand_links(Some("menu-home"), &menus);

        let view = model.view("Home", 1);
        let row = &view.items[1];
        assert!(row.submenu, "the link opens like a submenu");
        assert_eq!(row.children, ["Validate", "Next", "Home"], "the search box left out, the link back kept as a row");
        assert_eq!(row.child_groups, [Some("Check".to_owned()), Some("Plan".to_owned()), None]);
        assert_eq!(model.child_item_at(1, 1), Some(("n".into(), Some("menu-max".into()))), "an edit goes to the linked menu");
        assert_eq!(model.pick_child(1, 0), Step::Run("act-v".into()));

        let mut model = Model::new(vec![MenuItem::Action { id: "link".into(), label: "Max".into(), action_id: "menu-max".into(), enabled: true, pinned: false }], HashMap::new())
            .expand_links(Some("menu-home"), &menus);
        assert!(model.view("Home", 1).items[0].submenu, "a top-level link is a row, not an inline block");
        model.apply(Input::Pick(0));
        let view = model.view("Home", 1);
        assert_eq!(view.items.iter().map(|item| item.group.as_deref()).collect::<Vec<_>>(), [Some("Check"), Some("Plan"), None]);
        assert!(!view.items[2].submenu, "the link back to the opening menu is not expanded");
    }

    #[test]
    fn notes_show_on_the_row_and_on_a_submenus_names_and_are_searched() {
        let items = vec![
            MenuItem::Search { id: "menu-search".into(), enabled: true, all_menus: true },
            submenu("top", "Top", vec![action("a", "Ask"), submenu("more", "More", vec![action("v", "Validate"), action("n", "Next")])]),
        ];
        let mut model = Model::new(items, HashMap::new());
        model.notes = HashMap::from([("act-a".to_owned(), "asks a question".to_owned()), ("act-v".to_owned(), "checks every claim".to_owned())]);

        let view = model.view("Home", 1);
        let ask = view.items.iter().find(|item| item.label == "Ask").unwrap();
        assert_eq!(ask.note.as_deref(), Some("asks a question"));
        let more = view.items.iter().find(|item| item.label == "More").unwrap();
        assert_eq!(more.note, None);
        assert_eq!(more.child_notes, [Some("checks every claim".to_owned()), None]);

        model.set_query("every claim");
        let found: Vec<String> = model.view("Home", 2).items.iter().filter(|item| !item.search).map(|item| item.label.clone()).collect();
        assert_eq!(found, ["Validate"], "a description is searched like the name");
    }

    #[test]
    fn the_list_stays_put_while_its_tip_widens_and_the_tip_opens_where_it_fits() {
        let work = (0, 0, 1920, 1080);
        // Room on the right for the widest tip: right, and the list never moves.
        let right = Placement::pin(100, 250, work, 1360);
        assert!(!right.side_left);
        assert_eq!(right.room, 1570);
        assert_eq!(right.window_x(250 + 272, 272), 100);
        assert_eq!(right.window_x(250 + 816, 816), 100, "three columns: the list stays at 100");
        // Near the right edge: the tip opens left of the list, which still stays.
        let left = Placement::pin(1400, 250, work, 1360);
        assert!(left.side_left);
        assert_eq!(left.room, 1400);
        assert_eq!(left.window_x(250 + 272, 272), 1128);
        assert_eq!(left.window_x(250 + 816, 816), 584);
        assert_eq!(left.window_x(250 + 816, 816) + 816, 1400, "the list's left edge is where it was");
        // The widest does not fit either way: the side with more room.
        assert!(!Placement::pin(700, 250, work, 1360).side_left, "970 px right, 700 left");
        assert!(Placement::pin(900, 250, work, 1360).side_left, "770 px right, 900 left");
        // A monitor left of the primary.
        let other = Placement::pin(-300, 250, (-1920, 0, 0, 1080), 1360);
        assert!(other.side_left);
        assert_eq!(other.room, 1620);
        // A tip wider than its room is kept inside the work area.
        assert_eq!(Placement::pin(1700, 200, work, 1360).window_x(200 + 1800, 1800), 0);
    }
}
