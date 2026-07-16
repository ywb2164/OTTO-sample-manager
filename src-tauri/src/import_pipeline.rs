use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "ogg", "flac", "aiff", "aif", "m4a"];

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("scan callback failed: {0}")]
    Callback(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanFailure {
    pub path: Option<PathBuf>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub discovered: usize,
    pub cancelled: bool,
    pub failures: Vec<ScanFailure>,
}

pub fn scan_audio_files<F>(
    root: impl AsRef<Path>,
    cancel: Arc<AtomicBool>,
    batch_size: usize,
    mut on_batch: F,
) -> Result<ScanSummary, ScanError>
where
    F: FnMut(&[PathBuf]) -> Result<(), ScanError>,
{
    let batch_size = batch_size.max(1);
    let mut batch = Vec::with_capacity(batch_size);
    let mut summary = ScanSummary {
        discovered: 0,
        cancelled: false,
        failures: Vec::new(),
    };
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_descend);

    for entry in walker {
        if cancel.load(Ordering::Acquire) {
            summary.cancelled = true;
            break;
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                summary.failures.push(ScanFailure {
                    path: error.path().map(Path::to_path_buf),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().is_file() || !is_audio_path(entry.path()) {
            continue;
        }

        batch.push(entry.into_path());
        summary.discovered += 1;
        if batch.len() == batch_size {
            on_batch(&batch)?;
            batch.clear();
        }
    }

    if !summary.cancelled && !batch.is_empty() {
        on_batch(&batch)?;
    }
    Ok(summary)
}

fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            AUDIO_EXTENSIONS
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
        .unwrap_or(false)
}

fn should_descend(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_type().is_symlink() {
        return false;
    }
    !is_reparse_point(entry.path())
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse_point(_path: &Path) -> bool {
    false
}
