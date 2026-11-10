// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // If launched as the capture helper subprocess, run the LL keyboard hook
    // loop instead of the full Tauri application.
    if std::env::args().any(|arg| arg == "--capture-helper") {
        sidearm_lib::capture_helper_main();
        return;
    }

    // A Sidearm that died left the mice playing its silent signals: put their
    // own maps back once they answer (spawned by the orphaned capture helper).
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(pos) = args.iter().position(|arg| arg == sidearm_lib::RESTORE_LIVE_MAPS_ARG) {
            if let Some(dir) = args.get(pos + 1) {
                let after_crash = args.iter().any(|arg| arg == sidearm_lib::AFTER_CRASH_ARG);
                sidearm_lib::restore_live_maps_main(std::path::Path::new(dir), after_crash);
            }
            return;
        }
    }

    // Elevated one-shot helper: registers/deletes the admin autostart task on
    // behalf of a non-elevated Sidearm, then exits with the result code.
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(pos) = args.iter().position(|arg| arg == sidearm_lib::ADMIN_AUTOSTART_HELPER_ARG) {
            let action = args.get(pos + 1).map(String::as_str);
            std::process::exit(sidearm_lib::admin_autostart_helper_main(action));
        }
    }

    sidearm_lib::run()
}
