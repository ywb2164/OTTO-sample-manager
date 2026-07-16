use otto_sample_manager_lib::library_db::{
    LibraryDatabase, LibraryFolderRecord, LibraryMutationBatch, LibraryQuery, NewSampleRecord,
    SampleGroupReplacement,
};
use serde_json::json;
use std::fs;

#[test]
fn in_memory_database_supports_read_only_recovery_schema() {
    let database = LibraryDatabase::open_in_memory().expect("open recovery database");

    database.migrate().expect("migrate recovery database");

    assert_eq!(database.schema_version().expect("read schema version"), 2);
    assert_eq!(
        database
            .query_page(&LibraryQuery::default())
            .expect("query empty recovery library")
            .total,
        0
    );
}

#[test]
fn migration_creates_versioned_library_schema_in_wal_mode() {
    let temp_dir = tempfile::tempdir().expect("create temporary database directory");
    let database_path = temp_dir.path().join("library.sqlite3");
    let database = LibraryDatabase::open(&database_path).expect("open library database");

    database.migrate().expect("migrate library database");
    let reader =
        LibraryDatabase::open_read_only(&database_path).expect("open read-only connection");

    assert_eq!(database.schema_version().expect("read schema version"), 2);
    assert_eq!(database.journal_mode().expect("read journal mode"), "wal");
    assert_eq!(
        reader.schema_version().expect("read schema through reader"),
        2
    );
    assert_eq!(
        database.table_names().expect("list schema tables"),
        vec![
            "copy_settings",
            "drag_counts",
            "folders",
            "groups",
            "import_sessions",
            "sample_groups",
            "samples",
            "schema_migrations",
            "settings",
        ]
    );
}

#[test]
fn import_sessions_hide_pending_rows_commit_atomically_and_can_be_undone() {
    let temp_dir = tempfile::tempdir().expect("create temporary database directory");
    let database_path = temp_dir.path().join("library.sqlite3");
    let database = LibraryDatabase::open(&database_path).expect("open library database");
    database.migrate().expect("migrate library database");
    database
        .upsert_group("group-1", "常用", "#7c3aed", 0)
        .expect("create target group");

    database
        .create_import_session("session-1", "D:\\samples", Some("group-1"))
        .expect("create import session");
    database
        .insert_import_folders("session-1", &[folder("folder-1", "D:/samples")])
        .expect("insert pending folder hierarchy");
    assert!(
        database
            .bootstrap()
            .expect("pending bootstrap")
            .folders
            .is_empty()
    );
    let inserted = database
        .insert_import_batch(
            "session-1",
            &[
                new_sample("sample-1", "D:\\samples\\one.wav", "one", Some("folder-1")),
                new_sample("sample-2", "D:\\samples\\two.wav", "two", Some("folder-1")),
            ],
        )
        .expect("insert pending samples");
    assert_eq!(inserted.added, 2);
    assert_eq!(inserted.duplicates, 0);
    assert_eq!(
        database
            .query_page(&LibraryQuery::default())
            .expect("query committed samples")
            .total,
        0
    );

    database
        .commit_import_session("session-1")
        .expect("commit import session");
    let page = database
        .query_page(&LibraryQuery::default())
        .expect("query committed samples");
    assert_eq!(page.total, 2);
    assert_eq!(database.bootstrap().expect("bootstrap").folders.len(), 1);
    assert_eq!(
        page.items
            .iter()
            .map(|sample| sample.id.as_str())
            .collect::<Vec<_>>(),
        vec!["sample-1", "sample-2"]
    );

    database
        .create_import_session("session-2", "D:\\samples", Some("group-1"))
        .expect("create duplicate import session");
    let duplicate = database
        .insert_import_batch(
            "session-2",
            &[new_sample(
                "replacement-id",
                "D:\\samples\\one.wav",
                "one",
                None,
            )],
        )
        .expect("insert duplicate batch");
    assert_eq!(duplicate.added, 0);
    assert_eq!(duplicate.duplicates, 1);
    database
        .cancel_import_session("session-2")
        .expect("cancel duplicate session");
    assert_eq!(
        database
            .query_page(&LibraryQuery::default())
            .expect("query after cancel")
            .total,
        2
    );

    let undo = database
        .undo_last_import()
        .expect("undo import")
        .expect("undo summary");
    assert_eq!(undo.removed_samples, 2);
    assert_eq!(undo.removed_group_links, 2);
    assert_eq!(undo.removed_folders, 1);
    assert_eq!(
        database
            .query_page(&LibraryQuery::default())
            .expect("query after undo")
            .total,
        0
    );
    assert!(
        database
            .bootstrap()
            .expect("bootstrap after undo")
            .folders
            .is_empty()
    );
}

#[test]
fn paged_group_replacement_updates_links_without_loading_the_full_sample() {
    let database = LibraryDatabase::open_in_memory().expect("open library database");
    database.migrate().expect("migrate library database");
    database
        .upsert_group("group-1", "一", "#fff", 0)
        .expect("create first group");
    database
        .upsert_group("group-2", "二", "#000", 1)
        .expect("create second group");
    database
        .create_import_session("session-1", "D:\\samples", Some("group-1"))
        .expect("create import session");
    database
        .insert_import_batch(
            "session-1",
            &[new_sample("sample-1", "D:\\samples\\one.wav", "one", None)],
        )
        .expect("insert sample");
    database
        .commit_import_session("session-1")
        .expect("commit import");

    database
        .apply_mutations(&LibraryMutationBatch {
            replace_sample_groups: vec![SampleGroupReplacement {
                sample_id: "sample-1".to_owned(),
                group_ids: vec!["group-2".to_owned()],
            }],
            ..LibraryMutationBatch::default()
        })
        .expect("replace group links");

    let page = database
        .query_page(&LibraryQuery::default())
        .expect("query sample");
    assert_eq!(page.items[0].group_ids, vec!["group-2"]);
}

fn folder(id: &str, path: &str) -> LibraryFolderRecord {
    LibraryFolderRecord {
        id: id.to_owned(),
        parent_id: None,
        name: "samples".to_owned(),
        path: path.to_owned(),
        root_id: id.to_owned(),
        depth: 0,
        order: 0,
        is_expanded: true,
        imported_at: 1710000000000,
    }
}

fn new_sample(
    id: &str,
    file_path: &str,
    file_name: &str,
    folder_id: Option<&str>,
) -> NewSampleRecord {
    NewSampleRecord {
        id: id.to_owned(),
        folder_id: folder_id.map(str::to_owned),
        file_path: file_path.to_owned(),
        file_name: file_name.to_owned(),
        extension: ".wav".to_owned(),
        file_size: 1024,
        imported_at: 1710000000000,
        duration_ms: None,
        sample_rate: None,
        channels: None,
    }
}

#[test]
fn legacy_json_migration_is_backed_up_complete_and_idempotent() {
    let temp_dir = tempfile::tempdir().expect("create temporary migration directory");
    let database_path = temp_dir.path().join("library.sqlite3");
    let legacy_path = temp_dir.path().join("sample-manager-data.json");
    let backup_dir = temp_dir.path().join("backups");
    let audio_path = temp_dir.path().join("中文 sample.wav");
    fs::write(&audio_path, b"test audio bytes").expect("create source audio");

    let legacy = json!({
        "samples": {
            "sample-1": {
                "id": "sample-1",
                "fileName": "中文 sample",
                "fileExt": ".wav",
                "filePath": audio_path,
                "folderId": "folder-1",
                "originalId": "sample-1",
                "isCopy": false,
                "copyIndex": 0,
                "duration": 1.25,
                "sampleRate": 48000,
                "channels": 2,
                "fileSize": 16,
                "groupIds": ["group-1"],
                "importedAt": 1710000000000_i64
            }
        },
        "groups": {
            "group-1": {
                "id": "group-1",
                "name": "常用",
                "color": "#ff00aa",
                "sampleIds": ["sample-1"]
            }
        },
        "folderState": {
            "folders": {
                "folder-1": {
                    "id": "folder-1",
                    "name": "素材",
                    "path": "D:\\素材",
                    "sampleIds": ["sample-1"],
                    "childFolderIds": [],
                    "parentId": null,
                    "rootId": "folder-1",
                    "depth": 0,
                    "importedAt": 1710000000000_i64,
                    "isExpanded": true,
                    "order": 3
                }
            },
            "folderOrder": ["folder-1"]
        },
        "groupOrder": ["group-1"],
        "folderSettings": { "memoryOptimizationMode": true },
        "importUndoState": { "libraryRevision": 4, "receipt": null },
        "settings": { "windowAlwaysOnTop": true, "windowOpacity": 0.85 },
        "copySettings": { "enableAutoCopy": true, "keepCopies": false },
        "dragCounts": { audio_path.to_string_lossy(): 7 }
    });
    fs::write(
        &legacy_path,
        serde_json::to_vec_pretty(&legacy).expect("serialize legacy state"),
    )
    .expect("write legacy state");

    let database = LibraryDatabase::open(&database_path).expect("open library database");
    database.migrate().expect("migrate library database");

    let first = database
        .migrate_legacy_json(&legacy_path, &backup_dir)
        .expect("migrate legacy JSON");
    assert!(first.imported);
    let backup_path = first.backup_path.expect("migration backup path");
    assert!(backup_path.exists());
    assert!(
        fs::metadata(backup_path)
            .expect("backup metadata")
            .permissions()
            .readonly()
    );
    assert_eq!(first.samples, 1);
    assert_eq!(first.groups, 1);
    assert_eq!(first.folders, 1);
    assert_eq!(database.row_count("samples").expect("sample count"), 1);
    assert_eq!(
        database
            .row_count("sample_groups")
            .expect("sample group count"),
        1
    );
    assert_eq!(
        database.drag_count("sample-1").expect("drag count"),
        Some(7)
    );
    assert_eq!(
        database.setting_json("groupOrder").expect("group order"),
        Some(json!(["group-1"]))
    );

    let second = database
        .migrate_legacy_json(&legacy_path, &backup_dir)
        .expect("repeat migration");
    assert!(!second.imported);
    assert!(second.backup_path.is_none());
    assert_eq!(database.row_count("samples").expect("sample count"), 1);
    assert_eq!(
        database
            .row_count("sample_groups")
            .expect("sample group count"),
        1
    );
}

#[test]
fn legacy_json_migration_merges_duplicate_paths_and_ignores_missing_relations() {
    let temp_dir = tempfile::tempdir().expect("create temporary migration directory");
    let database_path = temp_dir.path().join("library.sqlite3");
    let legacy_path = temp_dir.path().join("sample-manager-data.json");
    let backup_dir = temp_dir.path().join("backups");
    let audio_path = temp_dir.path().join("重复 路径.wav");
    fs::write(&audio_path, b"duplicate path audio").expect("create source audio");

    let legacy = json!({
        "samples": {
            "sample-1": {
                "id": "sample-1",
                "fileName": "first",
                "fileExt": ".wav",
                "filePath": audio_path,
                "folderId": "missing-folder",
                "groupIds": ["missing-group"]
            },
            "sample-2": {
                "id": "sample-2",
                "fileName": "second",
                "fileExt": ".wav",
                "filePath": audio_path,
                "groupIds": ["group-1"]
            }
        },
        "groups": {
            "group-1": {
                "id": "group-1",
                "name": "重复路径仍可归组",
                "color": "#123456",
                "sampleIds": ["sample-2", "missing-sample"]
            }
        },
        "folderState": { "folders": {}, "folderOrder": [] },
        "dragCounts": { audio_path.to_string_lossy(): 3 }
    });
    fs::write(
        &legacy_path,
        serde_json::to_vec_pretty(&legacy).expect("serialize legacy state"),
    )
    .expect("write legacy state");

    let database = LibraryDatabase::open(&database_path).expect("open library database");
    database.migrate().expect("migrate library database");
    let report = database
        .migrate_legacy_json(&legacy_path, &backup_dir)
        .expect("merge duplicate legacy paths");

    assert_eq!(report.samples, 1);
    assert_eq!(database.row_count("samples").expect("sample count"), 1);
    assert_eq!(
        database
            .row_count("sample_groups")
            .expect("sample group count"),
        1
    );
    let page = database
        .query_page(&LibraryQuery {
            offset: 0,
            limit: 10,
            folder_id: None,
            group_id: Some("group-1".to_owned()),
        })
        .expect("query migrated group");
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        database.drag_count(&page.items[0].id).expect("drag count"),
        Some(3)
    );
}

#[test]
fn migrated_legacy_undo_receipt_can_be_applied_once() {
    let temp_dir = tempfile::tempdir().expect("create temporary migration directory");
    let database_path = temp_dir.path().join("library.sqlite3");
    let legacy_path = temp_dir.path().join("sample-manager-data.json");
    let backup_dir = temp_dir.path().join("backups");
    let first_path = temp_dir.path().join("existing.wav");
    let second_path = temp_dir.path().join("new.wav");
    fs::write(&first_path, b"first").expect("write first audio");
    fs::write(&second_path, b"second").expect("write second audio");

    let legacy = json!({
        "samples": {
            "sample-existing": {
                "id": "sample-existing",
                "fileName": "existing",
                "fileExt": ".wav",
                "filePath": first_path,
                "folderId": "folder-added",
                "groupIds": ["group-1"]
            },
            "sample-added": {
                "id": "sample-added",
                "fileName": "new",
                "fileExt": ".wav",
                "filePath": second_path,
                "folderId": "folder-added",
                "groupIds": ["group-1"]
            }
        },
        "groups": {
            "group-1": {
                "id": "group-1",
                "name": "test",
                "color": "#123456",
                "sampleIds": ["sample-existing", "sample-added"]
            }
        },
        "folderState": {
            "folders": {
                "folder-old": {
                    "id": "folder-old",
                    "name": "old",
                    "path": "D:\\old",
                    "parentId": null,
                    "rootId": "folder-old",
                    "depth": 0,
                    "order": 0,
                    "isExpanded": true
                },
                "folder-added": {
                    "id": "folder-added",
                    "name": "added",
                    "path": "D:\\added",
                    "parentId": null,
                    "rootId": "folder-added",
                    "depth": 0,
                    "order": 1,
                    "isExpanded": true
                }
            },
            "folderOrder": ["folder-old", "folder-added"]
        },
        "importUndoState": {
            "libraryRevision": 1,
            "receipt": {
                "transactionId": "legacy-import",
                "createdAt": 1,
                "expectedLibraryRevision": 1,
                "targetGroupId": "group-1",
                "addedSampleIds": ["sample-added"],
                "addedGroupLinks": [{ "sampleId": "sample-existing", "groupId": "group-1" }],
                "previousSampleFolderIds": [{ "sampleId": "sample-existing", "folderId": "folder-old" }],
                "addedFolderIds": ["folder-added"],
                "previousFolders": [{
                    "id": "folder-old",
                    "name": "old",
                    "path": "D:\\old",
                    "sampleIds": ["sample-existing"],
                    "childFolderIds": [],
                    "parentId": null,
                    "rootId": "folder-old",
                    "depth": 0,
                    "order": 0,
                    "isExpanded": true,
                    "importedAt": 0
                }],
                "previousFolderOrder": ["folder-old"],
                "summary": {
                    "scanned": 2,
                    "added": 1,
                    "linkedToGroup": 1,
                    "skipped": 1,
                    "failed": 0,
                    "targetGroupId": "group-1",
                    "failures": []
                }
            }
        }
    });
    fs::write(
        &legacy_path,
        serde_json::to_vec_pretty(&legacy).expect("serialize legacy state"),
    )
    .expect("write legacy state");

    let database = LibraryDatabase::open(&database_path).expect("open library database");
    database.migrate().expect("migrate library database");
    database
        .migrate_legacy_json(&legacy_path, &backup_dir)
        .expect("migrate legacy state");

    let summary = database
        .undo_last_import()
        .expect("undo migrated import")
        .expect("legacy undo summary");
    assert_eq!(summary.removed_samples, 1);
    assert_eq!(summary.removed_group_links, 1);
    assert_eq!(database.row_count("samples").expect("sample count"), 1);
    assert_eq!(database.row_count("folders").expect("folder count"), 1);
    assert_eq!(database.row_count("sample_groups").expect("group links"), 0);
    let page = database
        .query_page(&LibraryQuery {
            offset: 0,
            limit: 10,
            folder_id: Some("folder-old".to_owned()),
            group_id: None,
        })
        .expect("query restored folder");
    assert_eq!(page.items.len(), 1);
    assert!(database.undo_last_import().expect("second undo").is_none());
}
