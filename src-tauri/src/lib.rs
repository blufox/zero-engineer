mod backup;
mod bootstrap;
mod configs;
mod context;
mod dbsnap;
mod envfile;
mod files;
mod launch;
mod logs;
mod paths;
mod repos;
mod servers;
mod storage;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Remembers window size/position between launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let config = storage::load_config(app.handle());
            app.manage(storage::ConfigState(Mutex::new(config)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::get_app_config,
            storage::default_data_dir,
            storage::set_data_dir,
            storage::set_backup_dir,
            storage::read_json,
            storage::write_json,
            storage::delete_json,
            storage::list_json,
            storage::data_usage,
            files::import_text_file,
            files::export_text_file,
            repos::scan_repos,
            repos::fetch_repo,
            launch::open_in_editor,
            launch::open_terminal,
            launch::open_folder,
            launch::autostart_status,
            launch::set_autostart,
            launch::archive_data,
            servers::list_servers,
            servers::stop_process,
            servers::process_alive,
            configs::config_status,
            configs::scan_config_secrets,
            configs::export_configs,
            configs::config_backup_text,
            configs::config_current_text,
            backup::app_data_status,
            backup::export_app_data,
            backup::import_app_data,
            context::repo_context,
            context::env_drift_all,
            logs::log_sources,
            logs::read_log,
            logs::clear_log,
            dbsnap::db_tools,
            dbsnap::db_list,
            dbsnap::db_snapshot,
            dbsnap::db_restore,
            dbsnap::db_delete,
            dbsnap::db_prune,
            dbsnap::db_clear,
            bootstrap::bootstrap_scan,
            bootstrap::bootstrap_preview,
            bootstrap::bootstrap_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
