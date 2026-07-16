#![allow(linker_messages)]

pub mod audio_metadata;
pub mod audio_protocol;
pub mod commands;
pub mod copy_manager;
pub mod import_pipeline;
pub mod library_db;
pub mod lyrics_files;
#[cfg(windows)]
pub mod native_drag;
pub mod waveform_cache;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::Manager;

use commands::DesktopState;
use library_db::LibraryDatabase;

const PORTABLE_MARKER: &str = "otto-portable.flag";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("otto-audio", audio_protocol::handle)
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                return;
            }
            let state = window.state::<DesktopState>();
            if !state.writable {
                return;
            }
            if let Ok(database) = state.database.lock() {
                let keep_copies = database
                    .copy_setting_bool("keepCopies", false)
                    .unwrap_or(false);
                if !keep_copies {
                    let _ = fs::remove_dir_all(state.copy_root.join("drag-copies"));
                    let _ = database.reset_drag_counts();
                }
                let size = window.outer_size().ok();
                let opacity = state
                    .window_opacity
                    .lock()
                    .map(|value| *value)
                    .unwrap_or(1.0);
                let _ = database.set_setting_json(
                    "settings",
                    &serde_json::json!({
                        "windowAlwaysOnTop": window.is_always_on_top().unwrap_or(true),
                        "windowOpacity": opacity,
                        "windowWidth": size.map(|value| value.width).unwrap_or(380),
                        "windowHeight": size.map(|value| value.height).unwrap_or(700),
                    }),
                );
            }
        })
        .setup(|app| {
            let (data_dir, portable) = data_location(app.path().app_data_dir()?);
            fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("library.sqlite3");
            let (database, mut writable, mut startup_error) =
                open_database_with_recovery(&database_path)?;
            let backup_dir = data_dir.join("backups");
            if writable {
                for legacy_path in legacy_json_candidates(&data_dir, !portable) {
                    if !legacy_path.is_file() {
                        continue;
                    }
                    match database.migrate_legacy_json(&legacy_path, &backup_dir) {
                        Ok(report) if report.imported => break,
                        Ok(_) => continue,
                        Err(error) => {
                            startup_error = Some(format!(
                                "旧数据迁移失败，已进入只读安全模式；原 JSON、数据库与 Copy 目录均未改动。\n来源：{}\n错误：{}",
                                legacy_path.display(),
                                error
                            ));
                            writable = false;
                            break;
                        }
                    }
                }
            }
            let window_settings = database
                .setting_json("settings")
                .ok()
                .flatten()
                .unwrap_or_else(|| serde_json::json!({}));
            let opacity = window_settings
                .get("windowOpacity")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(1.0)
                .clamp(0.2, 1.0);
            let readers = if writable {
                (0..2)
                    .filter_map(|_| LibraryDatabase::open_read_only(&database_path).ok())
                    .collect()
            } else {
                Vec::new()
            };
            let state = DesktopState::new(
                database,
                readers,
                startup_error,
                writable,
                data_dir.join("cache").join("waveforms"),
                copy_root(&data_dir, !portable),
            );
            if let Ok(mut current_opacity) = state.window_opacity.lock() {
                *current_opacity = opacity;
            }
            let validation_state = state.clone();
            app.manage(state);
            commands::start_background_validation(validation_state);

            if let Some(window) = app.get_webview_window("main") {
                let width = window_settings
                    .get("windowWidth")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(380)
                    .clamp(300, 600) as u32;
                let height = window_settings
                    .get("windowHeight")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(700)
                    .max(500) as u32;
                let always_on_top = window_settings
                    .get("windowAlwaysOnTop")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);
                let _ = window.set_size(tauri::PhysicalSize::new(width, height));
                let _ = window.set_always_on_top(always_on_top);
                let _ = commands::set_native_window_opacity(&window, opacity);
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let work_area = monitor.work_area();
                    if let Ok(size) = window.outer_size() {
                        let x = work_area.position.x
                            + i32::try_from(work_area.size.width.saturating_sub(size.width))
                                .unwrap_or_default();
                        let y = work_area.position.y;
                        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::startup_status,
            commands::app_restart,
            commands::library_query_page,
            commands::library_get_bootstrap,
            commands::library_apply_mutations,
            commands::copy_settings_get,
            commands::copy_settings_set,
            commands::library_get_search_index_batch,
            commands::library_start_import,
            commands::library_cancel_import,
            commands::library_undo_last_import,
            commands::audio_get_stream_url,
            commands::audio_get_waveform,
            commands::get_files_info,
            commands::validate_files,
            commands::lyrics_read_text,
            commands::lyrics_create_files,
            commands::window_get_state,
            commands::window_set_always_on_top,
            commands::window_set_opacity,
            commands::window_minimize,
            commands::window_close,
            commands::app_version,
            #[cfg(windows)]
            commands::drag_start,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OTTO Sample Manager");
}

fn open_database_with_recovery(
    database_path: &Path,
) -> io::Result<(LibraryDatabase, bool, Option<String>)> {
    let persistent_database = LibraryDatabase::open(database_path).and_then(|database| {
        database.migrate()?;
        Ok(database)
    });
    match persistent_database {
        Ok(database) => Ok((database, true, None)),
        Err(error) => {
            let fallback = LibraryDatabase::open_in_memory()
                .and_then(|database| {
                    database.migrate()?;
                    Ok(database)
                })
                .map_err(|fallback_error| io::Error::other(fallback_error.to_string()))?;
            Ok((
                fallback,
                false,
                Some(format!(
                    "素材库数据库无法打开或升级，已进入只读安全模式；原数据库、旧 JSON 与 Copy 目录均未改动。\n数据库：{}\n错误：{}",
                    database_path.display(),
                    error
                )),
            ))
        }
    }
}

fn copy_root(data_dir: &std::path::Path, include_legacy_roots: bool) -> PathBuf {
    let mut candidates = vec![data_dir.join("Copy")];
    if include_legacy_roots {
        if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
            candidates.push(roaming.join("sample-manager").join("Copy"));
            candidates.push(roaming.join("采样管理器").join("Copy"));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| data_dir.join("Copy"))
}

fn data_location(default_data_dir: PathBuf) -> (PathBuf, bool) {
    if let Some(portable_dir) = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(portable_data_dir)
    {
        return (portable_dir, true);
    }
    let data_dir = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|roaming| roaming.join("sample-manager"))
        .unwrap_or(default_data_dir);
    (data_dir, false)
}

fn portable_data_dir(executable_path: &Path) -> Option<PathBuf> {
    let executable_dir = executable_path.parent()?;
    executable_dir
        .join(PORTABLE_MARKER)
        .is_file()
        .then(|| executable_dir.join("data"))
}

fn legacy_json_candidates(data_dir: &std::path::Path, include_shared_roots: bool) -> Vec<PathBuf> {
    let mut candidates = vec![data_dir.join("sample-manager-data.json")];
    if include_shared_roots {
        if let Some(roaming) = std::env::var_os("APPDATA") {
            let roaming = PathBuf::from(roaming);
            candidates.push(
                roaming
                    .join("sample-manager")
                    .join("sample-manager-data.json"),
            );
            candidates.push(roaming.join("采样管理器").join("sample-manager-data.json"));
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_database_enters_recovery_without_overwriting_the_file() {
        let temp_dir = tempfile::tempdir().expect("create temp directory");
        let database_path = temp_dir.path().join("library.sqlite3");
        let original = b"this is not a sqlite database";
        fs::write(&database_path, original).expect("write corrupt database fixture");

        let (database, writable, error) =
            open_database_with_recovery(&database_path).expect("open fallback database");

        assert!(!writable);
        assert!(
            error
                .as_deref()
                .is_some_and(|message| message.contains("只读安全模式"))
        );
        assert_eq!(database.schema_version().expect("read fallback schema"), 2);
        assert_eq!(
            fs::read(&database_path).expect("read original database"),
            original
        );
    }

    #[test]
    fn portable_marker_keeps_user_data_next_to_the_executable() {
        let temp_dir = tempfile::tempdir().expect("create temp directory");
        let executable_path = temp_dir.path().join("otto-sample-manager.exe");
        fs::write(temp_dir.path().join(PORTABLE_MARKER), b"portable")
            .expect("create portable marker");

        assert_eq!(
            portable_data_dir(&executable_path),
            Some(temp_dir.path().join("data"))
        );
        assert_eq!(
            legacy_json_candidates(&temp_dir.path().join("data"), false),
            vec![
                temp_dir
                    .path()
                    .join("data")
                    .join("sample-manager-data.json")
            ]
        );
        assert_eq!(
            copy_root(&temp_dir.path().join("data"), false),
            temp_dir.path().join("data").join("Copy")
        );
    }
}
