use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_LYRICS_TEXT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum LyricsFileError {
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("歌词文件必须是 .txt 格式")]
    UnsupportedTextFile,
    #[error("歌词文件超过 16 MiB 限制")]
    TextFileTooLarge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsFileItem {
    pub id: String,
    pub source_path: PathBuf,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsFilesPayload {
    pub target_group_name: String,
    pub items: Vec<LyricsFileItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsFileSuccess {
    pub id: String,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    pub file_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsFileFailure {
    pub id: String,
    pub source_path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsFilesResult {
    pub success: Vec<LyricsFileSuccess>,
    pub failed: Vec<LyricsFileFailure>,
    pub target_dir: Option<PathBuf>,
}

pub fn read_lyrics_text(path: impl AsRef<Path>) -> Result<Vec<u8>, LyricsFileError> {
    let path = path.as_ref();
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
    {
        return Err(LyricsFileError::UnsupportedTextFile);
    }
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_LYRICS_TEXT_BYTES {
        return Err(LyricsFileError::TextFileTooLarge);
    }
    Ok(fs::read(path)?)
}

pub fn create_lyrics_files(
    copy_root: impl AsRef<Path>,
    payload: &LyricsFilesPayload,
) -> LyricsFilesResult {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target_dir = copy_root.as_ref().join("lyrics-assemblies").join(format!(
        "{}_{}",
        sanitize_segment(&payload.target_group_name),
        timestamp
    ));
    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut created_target_dir = false;

    for item in &payload.items {
        if !item.source_path.is_file() {
            failed.push(failure(item, "source-missing"));
            continue;
        }
        if !created_target_dir && fs::create_dir_all(&target_dir).is_err() {
            failed.push(failure(item, "target-create-failed"));
            continue;
        }
        created_target_dir = true;
        let target_path = target_dir.join(sanitize_segment(&item.file_name));
        match fs::copy(&item.source_path, &target_path) {
            Ok(file_size) => success.push(LyricsFileSuccess {
                id: item.id.clone(),
                source_path: item.source_path.clone(),
                target_path,
                file_size,
            }),
            Err(_) => failed.push(failure(item, "copy-failed")),
        }
    }

    LyricsFilesResult {
        success,
        failed,
        target_dir: created_target_dir.then_some(target_dir),
    }
}

fn failure(item: &LyricsFileItem, reason: &str) -> LyricsFileFailure {
    LyricsFileFailure {
        id: item.id.clone(),
        source_path: item.source_path.clone(),
        reason: reason.to_owned(),
    }
}

fn sanitize_segment(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    sanitized = sanitized.trim().trim_matches('.').to_owned();
    if sanitized.is_empty() {
        "lyrics_group".to_owned()
    } else {
        sanitized
    }
}
