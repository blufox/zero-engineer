//! Reading/writing files at user-chosen absolute paths (import/export via file dialogs).
//! Unlike `storage`, these aren't confined to the data folder, so the frontend
//! only calls them with paths that came from an open/save dialog.

use std::fs;

const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

#[tauri::command]
pub fn import_text_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("File is larger than 10 MB".into());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}
