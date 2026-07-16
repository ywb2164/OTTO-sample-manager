use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use uuid::Uuid;

use crate::audio_metadata::probe_audio_metadata;
use crate::copy_manager::prepare_drag_files;
use crate::import_pipeline::{ScanError, scan_audio_files};
use crate::library_db::{
    ImportBatchSummary, LibraryBootstrap, LibraryDatabase, LibraryFolderRecord,
    LibraryMutationBatch, LibraryPage, LibraryQuery, NewSampleRecord, SearchDocumentBatch,
    UndoImportSummary,
};
use crate::lyrics_files::{
    LyricsFilesPayload, LyricsFilesResult, create_lyrics_files, read_lyrics_text,
};
#[cfg(windows)]
use crate::native_drag::start_native_drag;
use crate::waveform_cache::{WaveformPeaks, load_or_create_waveform};

const IMPORT_BATCH_SIZE: usize = 256;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct DesktopState {
    pub database: Arc<Mutex<LibraryDatabase>>,
    readers: Arc<Vec<Mutex<LibraryDatabase>>>,
    next_reader: Arc<AtomicUsize>,
    imports: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub startup_error: Option<String>,
    pub writable: bool,
    pub window_opacity: Arc<Mutex<f64>>,
    waveform_cache_dir: PathBuf,
    pub copy_root: PathBuf,
}

impl DesktopState {
    pub fn new(
        database: LibraryDatabase,
        readers: Vec<LibraryDatabase>,
        startup_error: Option<String>,
        writable: bool,
        waveform_cache_dir: PathBuf,
        copy_root: PathBuf,
    ) -> Self {
        Self {
            database: Arc::new(Mutex::new(database)),
            readers: Arc::new(readers.into_iter().map(Mutex::new).collect()),
            next_reader: Arc::new(AtomicUsize::new(0)),
            imports: Arc::new(Mutex::new(HashMap::new())),
            startup_error,
            writable,
            window_opacity: Arc::new(Mutex::new(1.0)),
            waveform_cache_dir,
            copy_root,
        }
    }

    pub(crate) fn read<T>(
        &self,
        operation: impl FnOnce(&LibraryDatabase) -> Result<T, crate::library_db::LibraryError>,
    ) -> Result<T, String> {
        if self.readers.is_empty() {
            let database = self.database.lock().map_err(lock_error)?;
            return operation(&database).map_err(|error| error.to_string());
        }
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let reader = self.readers[index].lock().map_err(lock_error)?;
        operation(&reader).map_err(|error| error.to_string())
    }

    fn ensure_writable(&self) -> Result<(), String> {
        self.writable
            .then_some(())
            .ok_or_else(|| "素材库处于只读安全模式；请先修复启动错误".to_owned())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub root_path: Option<String>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    pub target_group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub session_id: String,
    pub state: String,
    pub discovered: usize,
    pub processed: usize,
    pub added: usize,
    pub duplicates: usize,
    pub linked_to_group: usize,
    pub failed: usize,
    pub current_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub always_on_top: bool,
    pub opacity: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub exists: bool,
    pub file_size: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    pub error: Option<String>,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragResult {
    pub cancelled: bool,
    pub effect: u32,
    pub paths: Vec<PathBuf>,
}

#[tauri::command]
pub fn startup_status(state: State<'_, DesktopState>) -> StartupStatus {
    StartupStatus {
        error: state.startup_error.clone(),
        writable: state.writable,
    }
}

#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart()
}

#[tauri::command]
pub fn library_query_page(
    state: State<'_, DesktopState>,
    request: LibraryQuery,
) -> Result<LibraryPage, String> {
    state.read(|database| database.query_page(&request))
}

#[tauri::command]
pub fn library_get_bootstrap(state: State<'_, DesktopState>) -> Result<LibraryBootstrap, String> {
    state.read(LibraryDatabase::bootstrap)
}

#[tauri::command]
pub fn library_apply_mutations(
    state: State<'_, DesktopState>,
    batch: LibraryMutationBatch,
) -> Result<(), String> {
    state.ensure_writable()?;
    state
        .database
        .lock()
        .map_err(lock_error)?
        .apply_mutations(&batch)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn copy_settings_get(state: State<'_, DesktopState>) -> Result<serde_json::Value, String> {
    state.read(LibraryDatabase::copy_settings)
}

#[tauri::command]
pub fn copy_settings_set(
    state: State<'_, DesktopState>,
    settings: serde_json::Value,
) -> Result<(), String> {
    state.ensure_writable()?;
    state
        .database
        .lock()
        .map_err(lock_error)?
        .set_copy_settings(&settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn library_get_search_index_batch(
    state: State<'_, DesktopState>,
    offset: u32,
    limit: u32,
) -> Result<SearchDocumentBatch, String> {
    state.read(|database| database.search_document_batch(offset, limit))
}

#[tauri::command]
pub fn library_start_import(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: ImportRequest,
) -> Result<String, String> {
    state.ensure_writable()?;
    if request.file_paths.is_empty() && request.root_path.is_none() {
        return Err("请选择文件或目录".to_owned());
    }

    let session_id = Uuid::new_v4().to_string();
    let root_path = request
        .root_path
        .clone()
        .or_else(|| request.file_paths.first().cloned())
        .unwrap_or_default();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut imports = state.imports.lock().map_err(lock_error)?;
        if !imports.is_empty() {
            return Err("已有导入任务正在运行".to_owned());
        }
        imports.insert(session_id.clone(), Arc::clone(&cancel));
    }
    if let Err(error) = state
        .database
        .lock()
        .map_err(lock_error)?
        .create_import_session(&session_id, &root_path, request.target_group_id.as_deref())
    {
        if let Ok(mut imports) = state.imports.lock() {
            imports.remove(&session_id);
        }
        return Err(error.to_string());
    }

    let worker_state = state.inner().clone();
    let worker_session_id = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_import_worker(&app, worker_state, worker_session_id, request, cancel);
    });
    Ok(session_id)
}

#[tauri::command]
pub fn library_cancel_import(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<(), String> {
    let imports = state.imports.lock().map_err(lock_error)?;
    let Some(cancel) = imports.get(&session_id) else {
        return Ok(());
    };
    cancel.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn library_undo_last_import(
    state: State<'_, DesktopState>,
) -> Result<Option<UndoImportSummary>, String> {
    state.ensure_writable()?;
    state
        .database
        .lock()
        .map_err(lock_error)?
        .undo_last_import()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn audio_get_stream_url(sample_id: String) -> String {
    if cfg!(windows) {
        format!("http://otto-audio.localhost/{sample_id}")
    } else {
        format!("otto-audio://localhost/{sample_id}")
    }
}

#[tauri::command]
pub async fn audio_get_waveform(
    state: State<'_, DesktopState>,
    sample_id: String,
) -> Result<WaveformPeaks, String> {
    let path = state
        .read(|database| database.sample_path(&sample_id))?
        .ok_or_else(|| "找不到素材记录".to_owned())?;
    let cache_dir = state.waveform_cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        load_or_create_waveform(path, cache_dir)
            .map(|result| result.peaks)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(windows)]
#[tauri::command]
pub async fn drag_start(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    sample_ids: Vec<String>,
) -> Result<DragResult, String> {
    state.ensure_writable()?;
    let (sources, enable_auto_copy) = state.read(|database| {
        Ok((
            database.drag_sources(&sample_ids)?,
            database.copy_setting_bool("enableAutoCopy", true)?,
        ))
    })?;
    let prepared = prepare_drag_files(&sources, enable_auto_copy, &state.copy_root)
        .map_err(|error| error.to_string())?;
    if prepared.paths.is_empty() {
        return Err("没有可拖出的有效文件".to_owned());
    }

    let drag_paths = prepared.paths.clone();
    let drag_sample_ids = prepared.sample_ids.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let drag_window = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        let result = drag_window
            .hwnd()
            .map_err(|error| error.to_string())
            .and_then(|hwnd| {
                start_native_drag(hwnd, &drag_paths).map_err(|error| error.to_string())
            });
        let _ = sender.send(result);
    }) {
        let error = error.to_string();
        prepared
            .cancel()
            .map_err(|cleanup_error| format!("{error}; 清理未使用副本失败：{cleanup_error}"))?;
        return Err(error);
    }
    let drag_result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result)
    .and_then(|result| result);
    let outcome = match drag_result {
        Ok(outcome) => outcome,
        Err(error) => {
            prepared
                .cancel()
                .map_err(|cleanup_error| format!("{error}; 清理未使用副本失败：{cleanup_error}"))?;
            return Err(error);
        }
    };

    let result = DragResult {
        cancelled: outcome.cancelled,
        effect: outcome.effect,
        paths: prepared.paths.clone(),
    };
    if outcome.cancelled {
        prepared.cancel().map_err(|error| error.to_string())?;
    } else {
        state
            .database
            .lock()
            .map_err(lock_error)?
            .increment_drag_counts(&drag_sample_ids)
            .map_err(|error| error.to_string())?;
        prepared.commit();
    }
    Ok(result)
}

#[tauri::command]
pub fn get_files_info(file_paths: Vec<String>) -> Vec<FileInfo> {
    file_paths
        .into_iter()
        .map(|path| match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => FileInfo {
                path,
                exists: true,
                file_size: metadata.len(),
                reason: None,
            },
            Ok(_) => FileInfo {
                path,
                exists: false,
                file_size: 0,
                reason: Some("not-a-file".to_owned()),
            },
            Err(error) => FileInfo {
                path,
                exists: false,
                file_size: 0,
                reason: Some(error.to_string()),
            },
        })
        .collect()
}

#[tauri::command]
pub fn validate_files(file_paths: Vec<String>) -> Vec<serde_json::Value> {
    file_paths
        .into_iter()
        .map(|path| serde_json::json!({ "path": path, "valid": Path::new(&path).is_file() }))
        .collect()
}

#[tauri::command]
pub fn lyrics_read_text(file_path: String) -> Result<Vec<u8>, String> {
    read_lyrics_text(file_path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn lyrics_create_files(
    state: State<'_, DesktopState>,
    payload: LyricsFilesPayload,
) -> Result<LyricsFilesResult, String> {
    state.ensure_writable()?;
    Ok(create_lyrics_files(&state.copy_root, &payload))
}

#[tauri::command]
pub fn window_get_state(window: WebviewWindow, state: State<'_, DesktopState>) -> WindowState {
    WindowState {
        always_on_top: window.is_always_on_top().unwrap_or(true),
        opacity: state
            .window_opacity
            .lock()
            .map(|value| *value)
            .unwrap_or(1.0),
    }
}

#[tauri::command]
pub fn window_set_always_on_top(window: WebviewWindow, value: bool) -> Result<(), String> {
    window
        .set_always_on_top(value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_set_opacity(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    value: f64,
) -> Result<(), String> {
    let value = value.clamp(0.2, 1.0);
    set_native_window_opacity(&window, value)?;
    *state.window_opacity.lock().map_err(lock_error)? = value;
    Ok(())
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn run_import_worker(
    app: &AppHandle,
    state: DesktopState,
    session_id: String,
    request: ImportRequest,
    cancel: Arc<AtomicBool>,
) {
    let mut progress = ImportProgress {
        session_id: session_id.clone(),
        state: "scanning".to_owned(),
        discovered: 0,
        processed: 0,
        added: 0,
        duplicates: 0,
        linked_to_group: 0,
        failed: 0,
        current_path: None,
        message: None,
    };
    let _ = app.emit("import-progress", &progress);
    let mut last_emit = Instant::now();
    let folder_root = request
        .root_path
        .as_deref()
        .filter(|_| request.file_paths.is_empty())
        .map(PathBuf::from);
    let mut inserted_folder_ids = HashSet::new();

    let mut process_paths = |paths: &[PathBuf]| -> Result<(), ScanError> {
        if cancel.load(Ordering::Acquire) {
            return Ok(());
        }
        progress.discovered += paths.len();
        let imported_at = now_millis();
        let discovered_folders = folder_root
            .as_deref()
            .map(|root| folder_records_for_paths(root, paths, imported_at))
            .unwrap_or_default();
        let folder_ids = discovered_folders
            .iter()
            .map(|folder| (folder.path.clone(), folder.id.clone()))
            .collect::<HashMap<_, _>>();
        let folders = discovered_folders
            .into_iter()
            .filter(|folder| inserted_folder_ids.insert(folder.id.clone()))
            .collect::<Vec<_>>();
        let (records, failures) = records_from_paths(paths, &folder_ids, imported_at);
        progress.processed += paths.len();
        progress.failed += failures;
        progress.current_path = paths.last().map(|path| path.to_string_lossy().into_owned());
        let database = state
            .database
            .lock()
            .map_err(|error| ScanError::Callback(error.to_string()))?;
        database
            .insert_import_folders(&session_id, &folders)
            .map_err(|error| ScanError::Callback(error.to_string()))?;
        let batch = database
            .insert_import_batch(&session_id, &records)
            .map_err(|error| ScanError::Callback(error.to_string()))?;
        apply_batch_summary(&mut progress, batch);
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            let _ = app.emit("import-progress", &progress);
            last_emit = Instant::now();
        }
        Ok(())
    };

    let result = if !request.file_paths.is_empty() {
        let paths = request
            .file_paths
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let mut callback_error = None;
        for batch in paths.chunks(IMPORT_BATCH_SIZE) {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            if let Err(error) = process_paths(batch) {
                progress.message = Some(error.to_string());
                callback_error = Some(error);
                break;
            }
        }
        match callback_error {
            Some(error) => Err(error),
            None => Ok(cancel.load(Ordering::Acquire)),
        }
    } else {
        scan_audio_files(
            request.root_path.as_deref().unwrap_or_default(),
            Arc::clone(&cancel),
            IMPORT_BATCH_SIZE,
            &mut process_paths,
        )
        .map(|summary| {
            progress.failed += summary.failures.len();
            if progress.message.is_none() && !summary.failures.is_empty() {
                progress.message = Some(format!("{} 个目录或文件无法读取", summary.failures.len()));
            }
            summary.cancelled
        })
    };

    let cancelled = cancel.load(Ordering::Acquire) || matches!(result, Ok(true));
    let database_result = if cancelled {
        progress.state = "cancelled".to_owned();
        state
            .database
            .lock()
            .map_err(|error| error.to_string())
            .and_then(|database| {
                database
                    .cancel_import_session(&session_id)
                    .map_err(|error| error.to_string())
            })
    } else if let Err(error) = result {
        progress.state = "failed".to_owned();
        progress.message = Some(error.to_string());
        state
            .database
            .lock()
            .map_err(|error| error.to_string())
            .and_then(|database| {
                database
                    .cancel_import_session(&session_id)
                    .map_err(|error| error.to_string())
            })
    } else {
        progress.state = "committed".to_owned();
        state
            .database
            .lock()
            .map_err(|error| error.to_string())
            .and_then(|database| {
                database
                    .commit_import_session(&session_id)
                    .map_err(|error| error.to_string())
            })
    };
    if let Err(error) = database_result {
        progress.state = "failed".to_owned();
        progress.message = Some(error);
    }
    let _ = app.emit("import-progress", &progress);
    if let Ok(mut imports) = state.imports.lock() {
        imports.remove(&session_id);
    }
}

fn records_from_paths(
    paths: &[PathBuf],
    folder_ids: &HashMap<String, String>,
    imported_at: i64,
) -> (Vec<NewSampleRecord>, usize) {
    let concurrency = std::thread::available_parallelism()
        .map(|count| (count.get() / 2).clamp(1, 4))
        .unwrap_or(1)
        .min(paths.len().max(1));
    let chunk_size = paths.len().div_ceil(concurrency);
    let results = std::thread::scope(|scope| {
        paths
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|path| record_from_path(path, folder_ids, imported_at))
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect::<Vec<_>>()
    });
    let failures = results.iter().filter(|record| record.is_none()).count();
    let records = results.into_iter().flatten().collect();
    (records, failures)
}

fn record_from_path(
    path: &Path,
    folder_ids: &HashMap<String, String>,
    imported_at: i64,
) -> Option<NewSampleRecord> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return None,
    };
    let file_name = path.file_stem().and_then(|value| value.to_str())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let folder_id = path
        .parent()
        .map(normalized_path)
        .and_then(|parent| folder_ids.get(&parent).cloned());
    let audio_metadata = probe_audio_metadata(path);
    Some(NewSampleRecord {
        id: Uuid::new_v4().to_string(),
        folder_id,
        file_path: path.to_string_lossy().into_owned(),
        file_name: file_name.to_owned(),
        extension,
        file_size: metadata.len().min(i64::MAX as u64) as i64,
        imported_at,
        duration_ms: audio_metadata.duration_ms,
        sample_rate: audio_metadata.sample_rate,
        channels: audio_metadata.channels,
    })
}

fn folder_records_for_paths(
    root: &Path,
    paths: &[PathBuf],
    imported_at: i64,
) -> Vec<LibraryFolderRecord> {
    let root_path = normalized_path(root);
    let root_id = format!("folder_{root_path}");
    let mut directories = HashSet::new();
    directories.insert(root.to_path_buf());
    for path in paths {
        let mut current = path.parent();
        while let Some(directory) = current {
            if !directory.starts_with(root) {
                break;
            }
            directories.insert(directory.to_path_buf());
            if directory == root {
                break;
            }
            current = directory.parent();
        }
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort_by_key(|directory| directory.components().count());
    directories
        .into_iter()
        .map(|directory| {
            let path = normalized_path(&directory);
            let id = format!("folder_{path}");
            let parent_id = if directory == root {
                None
            } else {
                directory
                    .parent()
                    .map(|parent| format!("folder_{}", normalized_path(parent)))
            };
            let depth = directory
                .strip_prefix(root)
                .map(|relative| relative.components().count())
                .unwrap_or(0) as i64;
            let name = directory
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
                .unwrap_or_else(|| path.clone());
            LibraryFolderRecord {
                id,
                parent_id,
                name,
                path,
                root_id: root_id.clone(),
                depth,
                order: 0,
                is_expanded: depth == 0,
                imported_at,
            }
        })
        .collect()
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn apply_batch_summary(progress: &mut ImportProgress, batch: ImportBatchSummary) {
    progress.added += batch.added;
    progress.duplicates += batch.duplicates;
    progress.linked_to_group += batch.linked_to_group;
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub fn start_background_validation(state: DesktopState) {
    if !state.writable {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut offset = 0_u32;
        while let Ok(batch) = state.read(|database| database.validation_batch(offset, 128)) {
            if batch.is_empty() {
                break;
            }
            let mut updates = Vec::new();
            for candidate in &batch {
                let valid = Path::new(&candidate.file_path).is_file();
                let (file_size, fingerprint) =
                    validation_fingerprint(&candidate.file_path, candidate.file_size);
                if valid != candidate.is_valid || fingerprint != candidate.fingerprint {
                    updates.push((candidate.id.clone(), valid, file_size, fingerprint));
                }
            }
            if !updates.is_empty() {
                let _ = state
                    .database
                    .lock()
                    .map_err(lock_error)
                    .and_then(|database| {
                        database
                            .update_validation_batch(&updates)
                            .map_err(|error| error.to_string())
                    });
            }
            offset = offset.saturating_add(batch.len() as u32);
            std::thread::sleep(Duration::from_millis(10));
        }
    });
}

fn validation_fingerprint(path: &str, stored_size: i64) -> (i64, String) {
    let metadata = fs::metadata(path).ok();
    let size = metadata
        .as_ref()
        .map(|value| value.len().min(i64::MAX as u64) as i64)
        .unwrap_or(stored_size);
    let modified_millis = metadata
        .and_then(|value| value.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    (
        size,
        format!(
            "{}:{size}:{modified_millis}",
            path.replace('/', "\\").to_lowercase()
        ),
    )
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    error.to_string()
}

#[cfg(windows)]
pub(crate) fn set_native_window_opacity(
    window: &WebviewWindow,
    opacity: f64,
) -> Result<(), String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongW,
        WS_EX_LAYERED,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let alpha = (opacity * 255.0).round().clamp(0.0, 255.0) as u8;
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as i32);
        SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn set_native_window_opacity(
    _window: &WebviewWindow,
    _opacity: f64,
) -> Result<(), String> {
    Err("窗口透明度目前仅支持 Windows".to_owned())
}
