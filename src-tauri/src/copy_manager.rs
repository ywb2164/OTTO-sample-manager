use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct DragSource {
    pub id: String,
    pub path: PathBuf,
    pub drag_count: i64,
}

#[derive(Debug)]
pub struct PreparedDrag {
    pub paths: Vec<PathBuf>,
    pub sample_ids: Vec<String>,
    created_copies: Vec<PathBuf>,
}

impl PreparedDrag {
    pub fn cancel(self) -> std::io::Result<()> {
        for path in self.created_copies {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub fn commit(self) {}
}

pub fn prepare_drag_files(
    sources: &[DragSource],
    enable_auto_copy: bool,
    copy_root: impl AsRef<Path>,
) -> std::io::Result<PreparedDrag> {
    let copies_dir = copy_root.as_ref().join("drag-copies");
    let mut prepared = PreparedDrag {
        paths: Vec::with_capacity(sources.len()),
        sample_ids: Vec::with_capacity(sources.len()),
        created_copies: Vec::new(),
    };

    for source in sources {
        if !source.path.is_file() {
            continue;
        }
        let target_path = if !enable_auto_copy || source.drag_count == 0 {
            source.path.clone()
        } else {
            if let Err(error) = fs::create_dir_all(&copies_dir) {
                let _ = prepared.cancel();
                return Err(error);
            }
            let copy_index = next_copy_index(&copies_dir, source);
            let target = copies_dir.join(copy_file_name(source, copy_index));
            if let Err(error) = fs::copy(&source.path, &target) {
                let _ = prepared.cancel();
                return Err(error);
            }
            prepared.created_copies.push(target.clone());
            target
        };
        prepared.paths.push(target_path);
        prepared.sample_ids.push(source.id.clone());
    }
    Ok(prepared)
}

fn next_copy_index(copies_dir: &Path, source: &DragSource) -> usize {
    let extension = source
        .path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let prefix = copy_prefix(source);
    fs::read_dir(copies_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| {
            let suffix = if extension.is_empty() {
                name.strip_prefix(&prefix)
            } else {
                name.strip_prefix(&prefix)?
                    .strip_suffix(&format!(".{extension}"))
            }?;
            suffix.parse::<usize>().ok()
        })
        .max()
        .unwrap_or_default()
        + 1
}

fn copy_file_name(source: &DragSource, copy_index: usize) -> String {
    let extension = source
        .path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension.is_empty() {
        format!("{}{copy_index}", copy_prefix(source))
    } else {
        format!("{}{copy_index}.{extension}", copy_prefix(source))
    }
}

fn copy_prefix(source: &DragSource) -> String {
    let base_name = source
        .path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("sample");
    let mut safe_name = base_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    while safe_name.contains("__") {
        safe_name = safe_name.replace("__", "_");
    }
    let safe_name = safe_name.trim_matches('_');
    let safe_name = if safe_name.is_empty() {
        "sample"
    } else {
        safe_name
    };
    let short_id = source
        .id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    let short_id = if short_id.is_empty() {
        "source"
    } else {
        &short_id
    };
    format!("{safe_name}_{short_id}_copy")
}
