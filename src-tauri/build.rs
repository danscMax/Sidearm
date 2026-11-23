// Every `#[tauri::command]` in `generate_handler!` (lib.rs). Listing them turns on the
// app ACL: a command is then only callable from a window whose capability allows it
// (`allow-<command>` in capabilities/*.json) — the menu, OSD and cheat sheet windows get
// only their own. A command missing here is rejected everywhere; the test
// `app_acl_lists_every_command` keeps this list, the handler and the capabilities in sync.
const APP_COMMANDS: &[&str] = &[
    "menu_ready",
    "menu_layout",
    "menu_pick",
    "menu_hover",
    "menu_full_text",
    "menu_pick_child",
    "menu_edit",
    "set_key_recording",
    "cheatsheet_layout",
    "cheatsheet_ready",
    "osd_ready",
    "osd_click",
    "prompt_ready",
    "prompt_layout",
    "prompt_submit",
    "prompt_cancel",
    "export_layout_html",
    "export_layout_folder",
    "get_press_log",
    "menu_wheel",
    "menu_sheet_layer",
    "menu_search",
    "menu_search_scope",
    "resolve_shortcut_target",
    "menu_confirm",
    "menu_close",
    "menu_back",
    "export_verification_session",
    "load_config",
    "save_config",
    "get_app_paths",
    "list_backups",
    "restore_config_from_backup",
    "export_full_config",
    "import_full_config_preview",
    "import_full_config_apply",
    "open_config_folder",
    "accept_portable_migration",
    "parse_synapse_source",
    "import_synapse_into_config",
    "set_input_capture_mode",
    "live_map_ready",
    "start_runtime",
    "stop_runtime",
    "reload_runtime",
    "set_native_texts",
    "rehook_capture",
    "get_debug_log",
    "get_log_directory",
    "open_log_directory",
    "is_running_as_admin",
    "relaunch_as_admin",
    "get_admin_autostart_status",
    "set_admin_autostart",
    "capture_active_window",
    "list_running_processes",
    "list_bundled_presets",
    "read_bundled_preset",
    "preview_resolution",
    "execute_preview_action",
    "run_preview_action",
    "live_test_action",
    "get_exe_icon",
    "export_profile",
    "import_profile",
    "read_text_folder",
    "get_menu_usage",
    "export_snippets",
    "import_device_image",
    "read_device_image",
    "delete_device_image",
    "start_macro_recording",
    "record_keystroke",
    "stop_macro_recording",
    "restore_onboard_control",
    "get_synapse_status",
    "recover_from_synapse",
    "restore_synapse_startup",
    "get_native_model",
    "list_native_mice",
    "get_onboard_banks",
    "create_onboard_bank",
    "delete_onboard_bank",
    "flush_onboard_banks",
    "back_to_sidearm_bank",
    "get_sidearm_bank",
    "release_sidearm_bank",
    "move_sidearm_bank",
    "get_offline_preview",
    "get_device_report",
    "open_device_report_issue",
    "get_mouse_status",
    "set_key_signals",
    "open_startup_apps_settings",
    "get_mouse_settings",
    "set_mouse_dpi",
    "set_mouse_poll_rate",
];

fn main() {
    // Use uiAccess="true" manifest only for signed release builds.
    // In dev/debug mode, uiAccess="true" causes ERROR_ELEVATION_REQUIRED (740)
    // because the exe is neither signed nor in a secure location.
    let manifest = if std::env::var("SIDEARM_UIACCESS").as_deref() == Ok("true") {
        include_str!("manifest-uiaccess.xml")
    } else {
        include_str!("manifest.xml")
    };

    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
