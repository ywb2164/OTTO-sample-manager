use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::copy_manager::DragSource;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const SCHEMA_VERSION: i64 = 2;

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("legacy JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported table name: {0}")]
    UnsupportedTable(String),
}

pub type LibraryResult<T> = std::result::Result<T, LibraryError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub imported: bool,
    pub backup_path: Option<PathBuf>,
    pub samples: usize,
    pub groups: usize,
    pub folders: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSampleRecord {
    pub id: String,
    pub folder_id: Option<String>,
    pub file_path: String,
    pub file_name: String,
    pub extension: String,
    pub file_size: i64,
    pub imported_at: i64,
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryQuery {
    pub offset: u32,
    pub limit: u32,
    pub folder_id: Option<String>,
    pub group_id: Option<String>,
}

impl Default for LibraryQuery {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: 100,
            folder_id: None,
            group_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySample {
    pub id: String,
    pub folder_id: Option<String>,
    pub file_path: String,
    pub file_name: String,
    pub extension: String,
    pub original_id: String,
    pub is_copy: bool,
    pub copy_index: i64,
    pub file_size: i64,
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub is_valid: bool,
    pub imported_at: i64,
    pub group_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPage {
    pub items: Vec<LibrarySample>,
    pub total: u64,
    pub offset: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocument {
    pub id: String,
    pub file_name: String,
    pub extension: String,
    pub folder_id: Option<String>,
    pub group_ids: Vec<String>,
    pub imported_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocumentBatch {
    pub documents: Vec<SearchDocument>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ValidationCandidate {
    pub id: String,
    pub file_path: String,
    pub file_size: i64,
    pub is_valid: bool,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderRecord {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub path: String,
    pub root_id: String,
    pub depth: i64,
    pub order: i64,
    pub is_expanded: bool,
    pub imported_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroupRecord {
    pub id: String,
    pub name: String,
    pub color: String,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBootstrap {
    pub folders: Vec<LibraryFolderRecord>,
    pub groups: Vec<LibraryGroupRecord>,
    pub folder_order: Vec<String>,
    pub group_order: Vec<String>,
    pub settings: HashMap<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchSummary {
    pub added: usize,
    pub duplicates: usize,
    pub linked_to_group: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoImportSummary {
    pub removed_samples: usize,
    pub removed_group_links: usize,
    pub removed_folders: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryMutationBatch {
    pub upsert_samples: Vec<LibrarySample>,
    pub delete_sample_ids: Vec<String>,
    pub upsert_folders: Vec<LibraryFolderRecord>,
    pub delete_folder_ids: Vec<String>,
    pub upsert_groups: Vec<LibraryGroupRecord>,
    pub delete_group_ids: Vec<String>,
    pub replace_sample_groups: Vec<SampleGroupReplacement>,
    pub folder_order: Option<Vec<String>>,
    pub group_order: Option<Vec<String>>,
    pub folder_settings: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleGroupReplacement {
    pub sample_id: String,
    pub group_ids: Vec<String>,
}

pub struct LibraryDatabase {
    connection: Connection,
}

impl LibraryDatabase {
    pub fn open(path: impl AsRef<Path>) -> LibraryResult<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(Self { connection })
    }

    pub fn open_read_only(path: impl AsRef<Path>) -> LibraryResult<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        Ok(Self { connection })
    }

    pub fn open_in_memory() -> LibraryResult<Self> {
        let connection = Connection::open_in_memory()?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        Ok(Self { connection })
    }

    pub fn migrate(&self) -> LibraryResult<()> {
        self.connection.execute_batch(
            r#"
            BEGIN IMMEDIATE;

            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS import_sessions (
                id TEXT PRIMARY KEY,
                root_path TEXT NOT NULL,
                target_group_id TEXT,
                state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'cancelled', 'failed', 'undone')),
                discovered_count INTEGER NOT NULL DEFAULT 0,
                processed_count INTEGER NOT NULL DEFAULT 0,
                added_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                error_summary TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                import_session_id TEXT REFERENCES import_sessions(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                source_path TEXT,
                root_id TEXT NOT NULL,
                depth INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_expanded INTEGER NOT NULL DEFAULT 1,
                imported_at INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#7c3aed',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS samples (
                id TEXT PRIMARY KEY,
                folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
                import_session_id TEXT REFERENCES import_sessions(id) ON DELETE SET NULL,
                file_path TEXT NOT NULL UNIQUE,
                normalized_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                extension TEXT NOT NULL,
                original_id TEXT NOT NULL,
                is_copy INTEGER NOT NULL DEFAULT 0,
                copy_index INTEGER NOT NULL DEFAULT 0,
                file_size INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER,
                sample_rate INTEGER,
                channels INTEGER,
                is_valid INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('pending', 'committed')),
                fingerprint TEXT NOT NULL,
                imported_at INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sample_groups (
                sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
                group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                import_session_id TEXT REFERENCES import_sessions(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (sample_id, group_id)
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS drag_counts (
                sample_id TEXT PRIMARY KEY REFERENCES samples(id) ON DELETE CASCADE,
                drag_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS copy_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_samples_folder_status
                ON samples(folder_id, status, file_name);
            CREATE INDEX IF NOT EXISTS idx_samples_import_session
                ON samples(import_session_id, status);
            CREATE INDEX IF NOT EXISTS idx_samples_fingerprint
                ON samples(fingerprint);
            CREATE INDEX IF NOT EXISTS idx_folders_parent_sort
                ON folders(parent_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_groups_sort
                ON groups(sort_order);
            CREATE INDEX IF NOT EXISTS idx_sample_groups_group
                ON sample_groups(group_id, sample_id);

            INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);

            COMMIT;
            "#,
        )?;
        if !self.column_exists("folders", "import_session_id")? {
            self.connection.execute(
                "ALTER TABLE folders ADD COLUMN import_session_id TEXT REFERENCES import_sessions(id) ON DELETE SET NULL",
                [],
            )?;
        }
        self.connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_folders_import_session
                 ON folders(import_session_id);
             INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);",
        )?;
        Ok(())
    }

    fn column_exists(&self, table: &str, column: &str) -> LibraryResult<bool> {
        if table != "folders" {
            return Err(LibraryError::UnsupportedTable(table.to_owned()));
        }
        let mut statement = self.connection.prepare("PRAGMA table_info(folders)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        for existing in columns {
            if existing? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn schema_version(&self) -> LibraryResult<i64> {
        Ok(self
            .connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .optional()?
            .flatten()
            .unwrap_or_default())
    }

    pub fn journal_mode(&self) -> LibraryResult<String> {
        Ok(self
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?)
    }

    pub fn table_names(&self) -> LibraryResult<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT name FROM sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub const fn latest_schema_version() -> i64 {
        SCHEMA_VERSION
    }

    pub fn upsert_group(
        &self,
        id: &str,
        name: &str,
        color: &str,
        sort_order: i64,
    ) -> LibraryResult<()> {
        self.connection.execute(
            "INSERT INTO groups(id, name, color, sort_order) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                sort_order = excluded.sort_order,
                updated_at = CURRENT_TIMESTAMP",
            params![id, name, color, sort_order],
        )?;
        Ok(())
    }

    pub fn apply_mutations(&self, batch: &LibraryMutationBatch) -> LibraryResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for sample_id in &batch.delete_sample_ids {
            transaction.execute("DELETE FROM samples WHERE id = ?1", [sample_id])?;
        }
        for folder_id in &batch.delete_folder_ids {
            transaction.execute("DELETE FROM folders WHERE id = ?1", [folder_id])?;
        }
        for group_id in &batch.delete_group_ids {
            transaction.execute("DELETE FROM groups WHERE id = ?1", [group_id])?;
        }
        for group in &batch.upsert_groups {
            transaction.execute(
                "INSERT INTO groups(id, name, color, sort_order) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color,
                    sort_order = excluded.sort_order,
                    updated_at = CURRENT_TIMESTAMP",
                params![group.id, group.name, group.color, group.order],
            )?;
        }
        let mut folders = batch.upsert_folders.iter().collect::<Vec<_>>();
        folders.sort_by_key(|folder| folder.depth);
        for folder in folders {
            transaction.execute(
                "INSERT INTO folders(
                    id, parent_id, name, source_path, root_id, depth, sort_order, is_expanded, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    parent_id = excluded.parent_id,
                    name = excluded.name,
                    source_path = excluded.source_path,
                    root_id = excluded.root_id,
                    depth = excluded.depth,
                    sort_order = excluded.sort_order,
                    is_expanded = excluded.is_expanded,
                    imported_at = excluded.imported_at,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    folder.id,
                    folder.parent_id,
                    folder.name,
                    folder.path,
                    folder.root_id,
                    folder.depth,
                    folder.order,
                    folder.is_expanded,
                    folder.imported_at,
                ],
            )?;
        }
        for sample in &batch.upsert_samples {
            let normalized_path = normalize_path(&sample.file_path);
            let fingerprint = file_fingerprint(&sample.file_path, sample.file_size);
            transaction.execute(
                "INSERT INTO samples(
                    id, folder_id, file_path, normalized_path, file_name, extension,
                    original_id, is_copy, copy_index, file_size, duration_ms, sample_rate,
                    channels, is_valid, status, fingerprint, imported_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'committed', ?15, ?16
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    folder_id = excluded.folder_id,
                    file_path = excluded.file_path,
                    normalized_path = excluded.normalized_path,
                    file_name = excluded.file_name,
                    extension = excluded.extension,
                    original_id = excluded.original_id,
                    is_copy = excluded.is_copy,
                    copy_index = excluded.copy_index,
                    duration_ms = excluded.duration_ms,
                    sample_rate = excluded.sample_rate,
                    channels = excluded.channels,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    sample.id,
                    sample.folder_id,
                    sample.file_path,
                    normalized_path,
                    sample.file_name,
                    sample.extension,
                    sample.original_id,
                    sample.is_copy,
                    sample.copy_index,
                    sample.file_size,
                    sample.duration_ms,
                    sample.sample_rate,
                    sample.channels,
                    sample.is_valid,
                    fingerprint,
                    sample.imported_at,
                ],
            )?;
            transaction.execute(
                "DELETE FROM sample_groups WHERE sample_id = ?1",
                [&sample.id],
            )?;
            for group_id in &sample.group_ids {
                transaction.execute(
                    "INSERT OR IGNORE INTO sample_groups(sample_id, group_id) VALUES (?1, ?2)",
                    params![sample.id, group_id],
                )?;
            }
        }
        for replacement in &batch.replace_sample_groups {
            transaction.execute(
                "DELETE FROM sample_groups WHERE sample_id = ?1",
                [&replacement.sample_id],
            )?;
            for group_id in &replacement.group_ids {
                transaction.execute(
                    "INSERT OR IGNORE INTO sample_groups(sample_id, group_id) VALUES (?1, ?2)",
                    params![replacement.sample_id, group_id],
                )?;
            }
        }
        if let Some(folder_order) = &batch.folder_order {
            insert_json_value(
                &transaction,
                "settings",
                "folderOrder",
                &serde_json::to_value(folder_order)?,
            )?;
        }
        if let Some(group_order) = &batch.group_order {
            insert_json_value(
                &transaction,
                "settings",
                "groupOrder",
                &serde_json::to_value(group_order)?,
            )?;
        }
        if let Some(folder_settings) = &batch.folder_settings {
            insert_json_value(&transaction, "settings", "folderSettings", folder_settings)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn copy_settings(&self) -> LibraryResult<Value> {
        let mut statement = self
            .connection
            .prepare("SELECT key, value_json FROM copy_settings")?;
        let mut settings = serde_json::Map::new();
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (key, value) = row?;
            settings.insert(key, serde_json::from_str(&value)?);
        }
        if !settings.contains_key("enableAutoCopy") {
            settings.insert("enableAutoCopy".to_owned(), Value::Bool(true));
        }
        if !settings.contains_key("keepCopies") {
            settings.insert("keepCopies".to_owned(), Value::Bool(false));
        }
        Ok(Value::Object(settings))
    }

    pub fn set_copy_settings(&self, settings: &Value) -> LibraryResult<()> {
        let Some(settings) = settings.as_object() else {
            return Ok(());
        };
        let transaction = self.connection.unchecked_transaction()?;
        for (key, value) in settings {
            if matches!(key.as_str(), "enableAutoCopy" | "keepCopies") {
                insert_json_value(&transaction, "copy_settings", key, value)?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn create_import_session(
        &self,
        id: &str,
        root_path: &str,
        target_group_id: Option<&str>,
    ) -> LibraryResult<()> {
        self.connection.execute(
            "INSERT INTO import_sessions(id, root_path, target_group_id, state)
             VALUES (?1, ?2, ?3, 'pending')",
            params![id, root_path, target_group_id],
        )?;
        Ok(())
    }

    pub fn insert_import_folders(
        &self,
        session_id: &str,
        folders: &[LibraryFolderRecord],
    ) -> LibraryResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for folder in folders {
            transaction.execute(
                "INSERT OR IGNORE INTO folders(
                    id, parent_id, import_session_id, name, source_path, root_id,
                    depth, sort_order, is_expanded, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    folder.id,
                    folder.parent_id,
                    session_id,
                    folder.name,
                    folder.path,
                    folder.root_id,
                    folder.depth,
                    folder.order,
                    folder.is_expanded,
                    folder.imported_at,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn insert_import_batch(
        &self,
        session_id: &str,
        samples: &[NewSampleRecord],
    ) -> LibraryResult<ImportBatchSummary> {
        let transaction = self.connection.unchecked_transaction()?;
        let target_group_id = transaction.query_row(
            "SELECT target_group_id FROM import_sessions WHERE id = ?1 AND state = 'pending'",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )?;
        let mut summary = ImportBatchSummary {
            added: 0,
            duplicates: 0,
            linked_to_group: 0,
        };

        for sample in samples {
            let normalized_path = normalize_path(&sample.file_path);
            let fingerprint = file_fingerprint(&sample.file_path, sample.file_size);
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO samples(
                    id, folder_id, import_session_id, file_path, normalized_path, file_name,
                    extension, original_id, is_copy, copy_index, file_size, duration_ms,
                    sample_rate, channels, is_valid, status, fingerprint, imported_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?1, 0, 0, ?8, ?9, ?10, ?11, 1, 'pending', ?12, ?13
                 )",
                params![
                    sample.id,
                    sample.folder_id,
                    session_id,
                    sample.file_path,
                    normalized_path,
                    sample.file_name,
                    sample.extension,
                    sample.file_size,
                    sample.duration_ms,
                    sample.sample_rate,
                    sample.channels,
                    fingerprint,
                    sample.imported_at,
                ],
            )?;

            let sample_id = if inserted == 1 {
                summary.added += 1;
                sample.id.clone()
            } else {
                summary.duplicates += 1;
                let existing_id = transaction.query_row(
                    "SELECT id FROM samples WHERE file_path = ?1",
                    [&sample.file_path],
                    |row| row.get(0),
                )?;
                transaction.execute(
                    "UPDATE samples SET
                        file_name = ?2,
                        extension = ?3,
                        file_size = ?4,
                        is_valid = 1,
                        fingerprint = ?5,
                        updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?1",
                    params![
                        existing_id,
                        sample.file_name,
                        sample.extension,
                        sample.file_size,
                        fingerprint,
                    ],
                )?;
                existing_id
            };

            if let Some(group_id) = &target_group_id {
                summary.linked_to_group += transaction.execute(
                    "INSERT OR IGNORE INTO sample_groups(sample_id, group_id, import_session_id)
                     VALUES (?1, ?2, ?3)",
                    params![sample_id, group_id, session_id],
                )?;
            }
        }

        transaction.execute(
            "UPDATE import_sessions SET
                discovered_count = discovered_count + ?2,
                processed_count = processed_count + ?2,
                added_count = added_count + ?3,
                duplicate_count = duplicate_count + ?4
             WHERE id = ?1",
            params![
                session_id,
                samples.len() as i64,
                summary.added as i64,
                summary.duplicates as i64,
            ],
        )?;
        transaction.commit()?;
        Ok(summary)
    }

    pub fn commit_import_session(&self, session_id: &str) -> LibraryResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE import_sessions SET state = 'undone'
             WHERE state = 'committed' AND id <> ?1",
            [session_id],
        )?;
        transaction.execute("DELETE FROM settings WHERE key = 'importUndoState'", [])?;
        transaction.execute(
            "UPDATE samples SET status = 'committed', updated_at = CURRENT_TIMESTAMP
             WHERE import_session_id = ?1 AND status = 'pending'",
            [session_id],
        )?;
        transaction.execute(
            "UPDATE import_sessions SET state = 'committed', completed_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND state = 'pending'",
            [session_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn cancel_import_session(&self, session_id: &str) -> LibraryResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM sample_groups WHERE import_session_id = ?1",
            [session_id],
        )?;
        transaction.execute(
            "DELETE FROM samples WHERE import_session_id = ?1 AND status = 'pending'",
            [session_id],
        )?;
        transaction.execute(
            "DELETE FROM folders WHERE import_session_id = ?1",
            [session_id],
        )?;
        transaction.execute(
            "UPDATE import_sessions SET state = 'cancelled', completed_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND state = 'pending'",
            [session_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn undo_last_import(&self) -> LibraryResult<Option<UndoImportSummary>> {
        let session_id = self
            .connection
            .query_row(
                "SELECT id FROM import_sessions WHERE state = 'committed'
                 ORDER BY completed_at DESC, rowid DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            return self.undo_legacy_import();
        };

        let transaction = self.connection.unchecked_transaction()?;
        let removed_group_links = transaction.execute(
            "DELETE FROM sample_groups WHERE import_session_id = ?1",
            [&session_id],
        )?;
        let removed_samples = transaction.execute(
            "DELETE FROM samples WHERE import_session_id = ?1",
            [&session_id],
        )?;
        let removed_folders = transaction.execute(
            "DELETE FROM folders WHERE import_session_id = ?1",
            [&session_id],
        )?;
        transaction.execute(
            "UPDATE import_sessions SET state = 'undone' WHERE id = ?1",
            [&session_id],
        )?;
        transaction.commit()?;
        Ok(Some(UndoImportSummary {
            removed_samples,
            removed_group_links,
            removed_folders,
        }))
    }

    fn undo_legacy_import(&self) -> LibraryResult<Option<UndoImportSummary>> {
        let Some(stored) = self.setting_json("importUndoState")? else {
            return Ok(None);
        };
        let Some(receipt) = stored.get("receipt").and_then(Value::as_object) else {
            return Ok(None);
        };

        let added_sample_ids = receipt
            .get("addedSampleIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let added_folder_ids = receipt
            .get("addedFolderIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let added_group_links = receipt
            .get("addedGroupLinks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|link| {
                Some((
                    string_value(link, "sampleId")?.to_owned(),
                    string_value(link, "groupId")?.to_owned(),
                ))
            })
            .collect::<Vec<_>>();
        let previous_sample_folders = receipt
            .get("previousSampleFolderIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some((
                    string_value(item, "sampleId")?.to_owned(),
                    item.get("folderId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                ))
            })
            .collect::<Vec<_>>();
        let mut previous_folders = receipt
            .get("previousFolders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(legacy_folder_record)
            .collect::<Vec<_>>();
        previous_folders.sort_by_key(|folder| folder.depth);

        let all_added_samples_exist =
            added_sample_ids
                .iter()
                .try_fold(true, |all, id| -> LibraryResult<bool> {
                    if !all {
                        return Ok(false);
                    }
                    Ok(self.connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM samples WHERE id = ?1)",
                        [id],
                        |row| row.get::<_, bool>(0),
                    )?)
                })?;
        let all_added_folders_exist =
            added_folder_ids
                .iter()
                .try_fold(true, |all, id| -> LibraryResult<bool> {
                    if !all {
                        return Ok(false);
                    }
                    Ok(self.connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)",
                        [id],
                        |row| row.get::<_, bool>(0),
                    )?)
                })?;
        let all_added_links_exist = added_group_links.iter().try_fold(
            true,
            |all, (sample_id, group_id)| -> LibraryResult<bool> {
                if !all {
                    return Ok(false);
                }
                Ok(self.connection.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM sample_groups WHERE sample_id = ?1 AND group_id = ?2
                     )",
                    params![sample_id, group_id],
                    |row| row.get::<_, bool>(0),
                )?)
            },
        )?;
        if !all_added_samples_exist || !all_added_folders_exist || !all_added_links_exist {
            return Ok(None);
        }

        let transaction = self.connection.unchecked_transaction()?;
        let mut removed_group_links = 0;
        for (sample_id, group_id) in &added_group_links {
            removed_group_links += transaction.execute(
                "DELETE FROM sample_groups WHERE sample_id = ?1 AND group_id = ?2",
                params![sample_id, group_id],
            )?;
        }
        let mut removed_samples = 0;
        for sample_id in &added_sample_ids {
            removed_samples +=
                transaction.execute("DELETE FROM samples WHERE id = ?1", [sample_id])?;
        }
        let mut removed_folders = 0;
        for folder_id in added_folder_ids.iter().rev() {
            removed_folders +=
                transaction.execute("DELETE FROM folders WHERE id = ?1", [folder_id])?;
        }

        for folder in &previous_folders {
            transaction.execute(
                "INSERT INTO folders(
                    id, parent_id, name, source_path, root_id, depth,
                    sort_order, is_expanded, imported_at
                 ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    parent_id = NULL,
                    name = excluded.name,
                    source_path = excluded.source_path,
                    root_id = excluded.root_id,
                    depth = excluded.depth,
                    sort_order = excluded.sort_order,
                    is_expanded = excluded.is_expanded,
                    imported_at = excluded.imported_at,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    folder.id,
                    folder.name,
                    folder.path,
                    folder.root_id,
                    folder.depth,
                    folder.order,
                    folder.is_expanded,
                    folder.imported_at,
                ],
            )?;
        }
        for folder in &previous_folders {
            transaction.execute(
                "UPDATE folders SET parent_id = ?2 WHERE id = ?1",
                params![folder.id, folder.parent_id],
            )?;
        }
        for (sample_id, folder_id) in &previous_sample_folders {
            transaction.execute(
                "UPDATE samples SET folder_id = CASE
                    WHEN EXISTS(SELECT 1 FROM folders WHERE id = ?2) THEN ?2 ELSE NULL END
                 WHERE id = ?1",
                params![sample_id, folder_id],
            )?;
        }
        if let Some(previous_order) = receipt.get("previousFolderOrder") {
            insert_json_value(&transaction, "settings", "folderOrder", previous_order)?;
        }
        transaction.execute("DELETE FROM settings WHERE key = 'importUndoState'", [])?;
        transaction.commit()?;

        Ok(Some(UndoImportSummary {
            removed_samples,
            removed_group_links,
            removed_folders: removed_folders + previous_folders.len(),
        }))
    }

    pub fn query_page(&self, query: &LibraryQuery) -> LibraryResult<LibraryPage> {
        let limit = query.limit.clamp(1, 500);
        let total = self.connection.query_row(
            "SELECT COUNT(*) FROM samples s
             WHERE s.status = 'committed'
               AND (?1 IS NULL OR s.folder_id = ?1)
               AND (?2 IS NULL OR EXISTS (
                    SELECT 1 FROM sample_groups sg WHERE sg.sample_id = s.id AND sg.group_id = ?2
               ))",
            params![query.folder_id, query.group_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let mut statement = self.connection.prepare(
            "SELECT
                s.id, s.folder_id, s.file_path, s.file_name, s.extension,
                s.original_id, s.is_copy, s.copy_index, s.file_size, s.duration_ms,
                s.sample_rate, s.channels, s.is_valid, s.imported_at,
                COALESCE((
                    SELECT group_concat(sg.group_id, ',')
                    FROM sample_groups sg WHERE sg.sample_id = s.id
                ), '')
             FROM samples s
             WHERE s.status = 'committed'
               AND (?1 IS NULL OR s.folder_id = ?1)
               AND (?2 IS NULL OR EXISTS (
                    SELECT 1 FROM sample_groups sg WHERE sg.sample_id = s.id AND sg.group_id = ?2
               ))
             ORDER BY s.imported_at, s.id
             LIMIT ?3 OFFSET ?4",
        )?;
        let rows = statement.query_map(
            params![query.folder_id, query.group_id, limit, query.offset],
            |row| {
                let group_ids: String = row.get(14)?;
                Ok(LibrarySample {
                    id: row.get(0)?,
                    folder_id: row.get(1)?,
                    file_path: row.get(2)?,
                    file_name: row.get(3)?,
                    extension: row.get(4)?,
                    original_id: row.get(5)?,
                    is_copy: row.get(6)?,
                    copy_index: row.get(7)?,
                    file_size: row.get(8)?,
                    duration_ms: row.get(9)?,
                    sample_rate: row.get(10)?,
                    channels: row.get(11)?,
                    is_valid: row.get(12)?,
                    imported_at: row.get(13)?,
                    group_ids: group_ids
                        .split(',')
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .collect(),
                })
            },
        )?;
        let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = u64::from(query.offset) + (items.len() as u64) < total;
        Ok(LibraryPage {
            items,
            total,
            offset: query.offset,
            has_more,
        })
    }

    pub fn search_document_batch(
        &self,
        offset: u32,
        limit: u32,
    ) -> LibraryResult<SearchDocumentBatch> {
        let limit = limit.clamp(1, 2_000);
        let mut statement = self.connection.prepare(
            "SELECT
                s.id, s.file_name, s.extension, s.folder_id, s.imported_at,
                COALESCE((
                    SELECT group_concat(sg.group_id, ',')
                    FROM sample_groups sg WHERE sg.sample_id = s.id
                ), '')
             FROM samples s
             WHERE s.status = 'committed'
             ORDER BY s.imported_at, s.id
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit + 1, offset], |row| {
            let group_ids: String = row.get(5)?;
            Ok(SearchDocument {
                id: row.get(0)?,
                file_name: row.get(1)?,
                extension: row.get(2)?,
                folder_id: row.get(3)?,
                imported_at: row.get(4)?,
                group_ids: group_ids
                    .split(',')
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
            })
        })?;
        let mut documents = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = documents.len() > limit as usize;
        documents.truncate(limit as usize);
        Ok(SearchDocumentBatch {
            next_offset: has_more.then_some(offset.saturating_add(limit)),
            documents,
        })
    }

    pub fn sample_path(&self, sample_id: &str) -> LibraryResult<Option<PathBuf>> {
        Ok(self
            .connection
            .query_row(
                "SELECT file_path FROM samples WHERE id = ?1 AND status = 'committed'",
                [sample_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(PathBuf::from))
    }

    pub fn validation_batch(
        &self,
        offset: u32,
        limit: u32,
    ) -> LibraryResult<Vec<ValidationCandidate>> {
        let mut statement = self.connection.prepare(
            "SELECT id, file_path, file_size, is_valid, fingerprint
             FROM samples WHERE status = 'committed'
             ORDER BY imported_at, id LIMIT ?1 OFFSET ?2",
        )?;
        Ok(statement
            .query_map(params![limit.clamp(1, 500), offset], |row| {
                Ok(ValidationCandidate {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    file_size: row.get(2)?,
                    is_valid: row.get(3)?,
                    fingerprint: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_validation_batch(
        &self,
        updates: &[(String, bool, i64, String)],
    ) -> LibraryResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for (id, is_valid, file_size, fingerprint) in updates {
            transaction.execute(
                "UPDATE samples SET is_valid = ?2, file_size = ?3, fingerprint = ?4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, is_valid, file_size, fingerprint],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn bootstrap(&self) -> LibraryResult<LibraryBootstrap> {
        let mut folder_statement = self.connection.prepare(
            "SELECT f.id, f.parent_id, f.name, COALESCE(f.source_path, ''), f.root_id, f.depth,
                    f.sort_order, f.is_expanded, f.imported_at
             FROM folders f
             LEFT JOIN import_sessions i ON i.id = f.import_session_id
             WHERE f.import_session_id IS NULL OR i.state = 'committed'
             ORDER BY f.sort_order, f.imported_at, f.id",
        )?;
        let folders = folder_statement
            .query_map([], |row| {
                Ok(LibraryFolderRecord {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    name: row.get(2)?,
                    path: row.get(3)?,
                    root_id: row.get(4)?,
                    depth: row.get(5)?,
                    order: row.get(6)?,
                    is_expanded: row.get(7)?,
                    imported_at: row.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut group_statement = self
            .connection
            .prepare("SELECT id, name, color, sort_order FROM groups ORDER BY sort_order, id")?;
        let groups = group_statement
            .query_map([], |row| {
                Ok(LibraryGroupRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    order: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut settings_statement = self
            .connection
            .prepare("SELECT key, value_json FROM settings")?;
        let settings = settings_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (key, value) = row?;
                Ok((key, serde_json::from_str(&value)?))
            })
            .collect::<LibraryResult<HashMap<String, Value>>>()?;

        let mut folder_order: Vec<String> = settings
            .get("folderOrder")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| {
                folders
                    .iter()
                    .filter(|folder| folder.parent_id.is_none())
                    .map(|folder| folder.id.clone())
                    .collect()
            });
        folder_order.retain(|id| {
            folders
                .iter()
                .any(|folder| folder.id == *id && folder.parent_id.is_none())
        });
        for folder in folders.iter().filter(|folder| folder.parent_id.is_none()) {
            if !folder_order.contains(&folder.id) {
                folder_order.push(folder.id.clone());
            }
        }
        let mut group_order: Vec<String> = settings
            .get("groupOrder")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| groups.iter().map(|group| group.id.clone()).collect());
        group_order.retain(|id| groups.iter().any(|group| group.id == *id));
        for group in &groups {
            if !group_order.contains(&group.id) {
                group_order.push(group.id.clone());
            }
        }
        Ok(LibraryBootstrap {
            folders,
            groups,
            folder_order,
            group_order,
            settings,
        })
    }

    pub fn migrate_legacy_json(
        &self,
        legacy_path: impl AsRef<Path>,
        backup_dir: impl AsRef<Path>,
    ) -> LibraryResult<LegacyMigrationReport> {
        if self.setting_json("legacyJsonMigration")?.is_some() {
            return Ok(LegacyMigrationReport {
                imported: false,
                backup_path: None,
                samples: 0,
                groups: 0,
                folders: 0,
            });
        }

        let legacy_path = legacy_path.as_ref();
        if !legacy_path.is_file() {
            return Ok(LegacyMigrationReport {
                imported: false,
                backup_path: None,
                samples: 0,
                groups: 0,
                folders: 0,
            });
        }

        let bytes = fs::read(legacy_path)?;
        let legacy: Value = serde_json::from_slice(&bytes)?;
        fs::create_dir_all(backup_dir.as_ref())?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let backup_path = backup_dir
            .as_ref()
            .join(format!("sample-manager-data.{timestamp}.json"));
        fs::copy(legacy_path, &backup_path)?;
        let mut permissions = fs::metadata(&backup_path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&backup_path, permissions)?;

        let transaction = self.connection.unchecked_transaction()?;
        let mut folders_imported = 0;
        let mut groups_imported = 0;
        let mut sample_id_by_legacy_id = HashMap::<String, String>::new();
        let mut migrated_sample_ids = HashSet::<String>::new();

        let folder_state = legacy.get("folderState").and_then(Value::as_object);
        let folder_values = folder_state
            .and_then(|state| state.get("folders"))
            .and_then(Value::as_object);
        if let Some(folders) = folder_values {
            for (fallback_id, folder) in folders {
                let id = string_value(folder, "id").unwrap_or(fallback_id);
                let name = string_value(folder, "name").unwrap_or("未命名文件夹");
                let source_path = string_value(folder, "path");
                let root_id = string_value(folder, "rootId").unwrap_or(id);
                let depth = integer_value(folder, "depth").unwrap_or_default();
                let order = integer_value(folder, "order").unwrap_or_default();
                let is_expanded = bool_value(folder, "isExpanded").unwrap_or(true);
                let imported_at = integer_value(folder, "importedAt").unwrap_or_default();
                folders_imported += transaction.execute(
                    "INSERT OR IGNORE INTO folders(
                        id, parent_id, name, source_path, root_id, depth, sort_order, is_expanded, imported_at
                     ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![id, name, source_path, root_id, depth, order, is_expanded, imported_at],
                )?;
            }

            for (fallback_id, folder) in folders {
                let id = string_value(folder, "id").unwrap_or(fallback_id);
                let parent_id = string_value(folder, "parentId");
                transaction.execute(
                    "UPDATE folders SET parent_id = ?2 WHERE id = ?1",
                    params![id, parent_id],
                )?;
            }
        }

        let group_order = legacy
            .get("groupOrder")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(groups) = legacy.get("groups").and_then(Value::as_object) {
            for (fallback_id, group) in groups {
                let id = string_value(group, "id").unwrap_or(fallback_id);
                let name = string_value(group, "name").unwrap_or("未命名分组");
                let color = string_value(group, "color").unwrap_or("#7c3aed");
                let sort_order = group_order
                    .iter()
                    .position(|value| value.as_str() == Some(id))
                    .map(|index| index as i64)
                    .unwrap_or(i64::MAX);
                groups_imported += transaction.execute(
                    "INSERT OR IGNORE INTO groups(id, name, color, sort_order) VALUES (?1, ?2, ?3, ?4)",
                    params![id, name, color, sort_order],
                )?;
            }
        }

        if let Some(samples) = legacy.get("samples").and_then(Value::as_object) {
            for (fallback_id, sample) in samples {
                let id = string_value(sample, "id").unwrap_or(fallback_id);
                let Some(file_path) = string_value(sample, "filePath") else {
                    continue;
                };
                let file_name = string_value(sample, "fileName").unwrap_or(id);
                let extension = string_value(sample, "fileExt").unwrap_or_default();
                let folder_id = string_value(sample, "folderId");
                let original_id = string_value(sample, "originalId").unwrap_or(id);
                let is_copy = bool_value(sample, "isCopy").unwrap_or(false);
                let copy_index = integer_value(sample, "copyIndex").unwrap_or_default();
                let file_size = integer_value(sample, "fileSize").unwrap_or_default();
                let duration_ms = sample
                    .get("duration")
                    .and_then(Value::as_f64)
                    .map(|seconds| (seconds * 1000.0).round() as i64);
                let sample_rate = integer_value(sample, "sampleRate");
                let channels = integer_value(sample, "channels");
                let imported_at = integer_value(sample, "importedAt").unwrap_or_default();
                let normalized_path = normalize_path(file_path);
                let fingerprint = file_fingerprint(file_path, file_size);
                transaction.execute(
                    "INSERT INTO samples(
                        id, folder_id, file_path, normalized_path, file_name, extension,
                        original_id, is_copy, copy_index, file_size, duration_ms, sample_rate,
                        channels, is_valid, status, fingerprint, imported_at
                     ) VALUES (
                         ?1,
                         CASE WHEN EXISTS (SELECT 1 FROM folders WHERE id = ?2) THEN ?2 ELSE NULL END,
                         ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                         1, 'committed', ?14, ?15
                     )
                     ON CONFLICT(file_path) DO UPDATE SET
                        file_name = excluded.file_name,
                        extension = excluded.extension,
                        folder_id = excluded.folder_id,
                        file_size = excluded.file_size,
                        duration_ms = excluded.duration_ms,
                        sample_rate = excluded.sample_rate,
                        channels = excluded.channels,
                        fingerprint = excluded.fingerprint,
                        updated_at = CURRENT_TIMESTAMP",
                    params![
                        id,
                        folder_id,
                        file_path,
                        normalized_path,
                        file_name,
                        extension,
                        original_id,
                        is_copy,
                        copy_index,
                        file_size,
                        duration_ms,
                        sample_rate,
                        channels,
                        fingerprint,
                        imported_at,
                    ],
                )?;

                let persisted_id = transaction.query_row(
                    "SELECT id FROM samples WHERE file_path = ?1",
                    [file_path],
                    |row| row.get::<_, String>(0),
                )?;
                sample_id_by_legacy_id.insert(id.to_owned(), persisted_id.clone());
                migrated_sample_ids.insert(persisted_id.clone());

                if let Some(group_ids) = sample.get("groupIds").and_then(Value::as_array) {
                    for group_id in group_ids.iter().filter_map(Value::as_str) {
                        transaction.execute(
                            "INSERT OR IGNORE INTO sample_groups(sample_id, group_id)
                             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?2)",
                            params![persisted_id, group_id],
                        )?;
                    }
                }
            }
        }
        let samples_imported = migrated_sample_ids.len();

        if let Some(groups) = legacy.get("groups").and_then(Value::as_object) {
            for (fallback_id, group) in groups {
                let group_id = string_value(group, "id").unwrap_or(fallback_id);
                if let Some(sample_ids) = group.get("sampleIds").and_then(Value::as_array) {
                    for legacy_sample_id in sample_ids.iter().filter_map(Value::as_str) {
                        let sample_id = sample_id_by_legacy_id
                            .get(legacy_sample_id)
                            .map(String::as_str)
                            .unwrap_or(legacy_sample_id);
                        transaction.execute(
                            "INSERT OR IGNORE INTO sample_groups(sample_id, group_id)
                             SELECT ?1, ?2
                             WHERE EXISTS (SELECT 1 FROM samples WHERE id = ?1)
                               AND EXISTS (SELECT 1 FROM groups WHERE id = ?2)",
                            params![sample_id, group_id],
                        )?;
                    }
                }
            }
        }

        for key in ["groupOrder", "folderSettings", "settings"] {
            if let Some(value) = legacy.get(key) {
                insert_json_value(&transaction, "settings", key, value)?;
            }
        }
        if let Some(import_undo_state) = legacy.get("importUndoState") {
            let remapped = remap_legacy_import_undo(import_undo_state, &sample_id_by_legacy_id);
            insert_json_value(&transaction, "settings", "importUndoState", &remapped)?;
        }
        if let Some(folder_order) = folder_state.and_then(|state| state.get("folderOrder")) {
            insert_json_value(&transaction, "settings", "folderOrder", folder_order)?;
        }
        if let Some(copy_settings) = legacy.get("copySettings").and_then(Value::as_object) {
            for (key, value) in copy_settings {
                insert_json_value(&transaction, "copy_settings", key, value)?;
            }
        }
        if let Some(drag_counts) = legacy.get("dragCounts").and_then(Value::as_object) {
            for (file_path, count) in drag_counts {
                let Some(drag_count) = count.as_i64() else {
                    continue;
                };
                transaction.execute(
                    "INSERT INTO drag_counts(sample_id, drag_count)
                     SELECT id, ?2 FROM samples WHERE file_path = ?1
                     ON CONFLICT(sample_id) DO UPDATE SET drag_count = excluded.drag_count",
                    params![file_path, drag_count],
                )?;
            }
        }

        insert_json_value(
            &transaction,
            "settings",
            "legacyJsonMigration",
            &serde_json::json!({
                "source": legacy_path,
                "backup": backup_path,
                "completedAt": timestamp,
            }),
        )?;
        transaction.commit()?;

        Ok(LegacyMigrationReport {
            imported: true,
            backup_path: Some(backup_path),
            samples: samples_imported,
            groups: groups_imported,
            folders: folders_imported,
        })
    }

    pub fn setting_json(&self, key: &str) -> LibraryResult<Option<Value>> {
        let value = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(LibraryError::from))
            .transpose()
    }

    pub fn set_setting_json(&self, key: &str, value: &Value) -> LibraryResult<()> {
        insert_json_value(&self.connection, "settings", key, value)
    }

    pub fn drag_count(&self, sample_id: &str) -> LibraryResult<Option<i64>> {
        Ok(self
            .connection
            .query_row(
                "SELECT drag_count FROM drag_counts WHERE sample_id = ?1",
                [sample_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn drag_sources(&self, sample_ids: &[String]) -> LibraryResult<Vec<DragSource>> {
        let mut statement = self.connection.prepare(
            "SELECT s.id, s.file_path, COALESCE(dc.drag_count, 0)
             FROM samples s
             LEFT JOIN drag_counts dc ON dc.sample_id = s.id
             WHERE s.id = ?1 AND s.status = 'committed'",
        )?;
        let mut sources = Vec::with_capacity(sample_ids.len());
        for sample_id in sample_ids {
            if let Some(source) = statement
                .query_row([sample_id], |row| {
                    Ok(DragSource {
                        id: row.get(0)?,
                        path: PathBuf::from(row.get::<_, String>(1)?),
                        drag_count: row.get(2)?,
                    })
                })
                .optional()?
            {
                sources.push(source);
            }
        }
        Ok(sources)
    }

    pub fn copy_setting_bool(&self, key: &str, default: bool) -> LibraryResult<bool> {
        let value = self
            .connection
            .query_row(
                "SELECT value_json FROM copy_settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .and_then(|value| value.as_bool())
            .unwrap_or(default))
    }

    pub fn increment_drag_counts(&self, sample_ids: &[String]) -> LibraryResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for sample_id in sample_ids {
            transaction.execute(
                "INSERT INTO drag_counts(sample_id, drag_count) VALUES (?1, 1)
                 ON CONFLICT(sample_id) DO UPDATE SET
                    drag_count = drag_count + 1,
                    updated_at = CURRENT_TIMESTAMP",
                [sample_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn reset_drag_counts(&self) -> LibraryResult<()> {
        self.connection.execute("DELETE FROM drag_counts", [])?;
        Ok(())
    }

    pub fn row_count(&self, table: &str) -> LibraryResult<i64> {
        const TABLES: &[&str] = &[
            "samples",
            "folders",
            "groups",
            "sample_groups",
            "import_sessions",
            "settings",
            "drag_counts",
            "copy_settings",
            "schema_migrations",
        ];
        if !TABLES.contains(&table) {
            return Err(LibraryError::UnsupportedTable(table.to_owned()));
        }
        Ok(self
            .connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })?)
    }
}

fn string_value<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn legacy_folder_record(value: &Value) -> Option<LibraryFolderRecord> {
    let id = string_value(value, "id")?.to_owned();
    Some(LibraryFolderRecord {
        parent_id: string_value(value, "parentId").map(str::to_owned),
        name: string_value(value, "name")
            .unwrap_or("未命名文件夹")
            .to_owned(),
        path: string_value(value, "path").unwrap_or_default().to_owned(),
        root_id: string_value(value, "rootId").unwrap_or(&id).to_owned(),
        depth: integer_value(value, "depth").unwrap_or_default(),
        order: integer_value(value, "order").unwrap_or_default(),
        is_expanded: bool_value(value, "isExpanded").unwrap_or(true),
        imported_at: integer_value(value, "importedAt").unwrap_or_default(),
        id,
    })
}

fn remap_legacy_import_undo(
    stored: &Value,
    sample_id_by_legacy_id: &HashMap<String, String>,
) -> Value {
    let mut remapped = stored.clone();
    let Some(receipt) = remapped.get_mut("receipt").and_then(Value::as_object_mut) else {
        return remapped;
    };

    if let Some(sample_ids) = receipt
        .get_mut("addedSampleIds")
        .and_then(Value::as_array_mut)
    {
        let mut seen = HashSet::new();
        *sample_ids = sample_ids
            .iter()
            .filter_map(Value::as_str)
            .map(|legacy_id| {
                sample_id_by_legacy_id
                    .get(legacy_id)
                    .map(String::as_str)
                    .unwrap_or(legacy_id)
                    .to_owned()
            })
            .filter(|id| seen.insert(id.clone()))
            .map(Value::String)
            .collect();
    }
    for key in ["addedGroupLinks", "previousSampleFolderIds"] {
        let Some(items) = receipt.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            let Some(object) = item.as_object_mut() else {
                continue;
            };
            let Some(legacy_id) = object.get("sampleId").and_then(Value::as_str) else {
                continue;
            };
            if let Some(actual_id) = sample_id_by_legacy_id.get(legacy_id) {
                object.insert("sampleId".to_owned(), Value::String(actual_id.clone()));
            }
        }
    }
    remapped
}

fn integer_value(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn bool_value(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn file_fingerprint(path: &str, file_size: i64) -> String {
    let modified_millis = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}:{file_size}:{modified_millis}", normalize_path(path))
}

fn insert_json_value(
    connection: &Connection,
    table: &str,
    key: &str,
    value: &Value,
) -> LibraryResult<()> {
    if !matches!(table, "settings" | "copy_settings") {
        return Err(LibraryError::UnsupportedTable(table.to_owned()));
    }
    connection.execute(
        &format!(
            "INSERT INTO {table}(key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP"
        ),
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}
