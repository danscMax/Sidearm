// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // If launched as the capture helper subprocess, run the LL keyboard hook
    // loop instead of the full Tauri application.
    if std::env::args().any(|arg| arg == "--capture-helper") {
        sidearm_lib::capture_helper_main();
        return;
    }

    // Self-elevation entry for the admin-autostart toggle.  The parent
    // Sidearm calls `ShellExecuteExW(runas, ourselves, --admin-autostart ...)`
    // so this branch runs in a short-lived elevated child that creates/deletes
    // the scheduled task via schtasks + CREATE_NO_WINDOW (no console flash).
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(pos) = args.iter().position(|a| a == "--admin-autostart") {
            let action = args.get(pos + 1).map(String::as_str).unwrap_or("");
            let code = match action {
                "enable" => sidearm_lib::admin_autostart_silent_enable(),
                "disable" => sidearm_lib::admin_autostart_silent_disable(),
                _ => 1,
            };
            std::process::exit(code);
        }
    }

    sidearm_lib::run()
}
