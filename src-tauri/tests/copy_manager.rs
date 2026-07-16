use std::fs;

use otto_sample_manager_lib::copy_manager::{DragSource, prepare_drag_files};

#[test]
fn copy_policy_is_independent_per_file_and_cancel_removes_only_new_copies() {
    let temp_dir = tempfile::tempdir().expect("create copy manager temp directory");
    let first = temp_dir.path().join("第一次.wav");
    let second = temp_dir.path().join("again.wav");
    fs::write(&first, b"first").expect("write first source");
    fs::write(&second, b"second").expect("write second source");
    let copy_root = temp_dir.path().join("Copy");

    let prepared = prepare_drag_files(
        &[
            DragSource {
                id: "first".into(),
                path: first.clone(),
                drag_count: 0,
            },
            DragSource {
                id: "second".into(),
                path: second.clone(),
                drag_count: 2,
            },
        ],
        true,
        &copy_root,
    )
    .expect("prepare drag files");

    assert_eq!(prepared.paths[0], first);
    assert_ne!(prepared.paths[1], second);
    assert!(prepared.paths[1].is_file());
    let created_copy = prepared.paths[1].clone();
    prepared.cancel().expect("cancel prepared drag");
    assert!(!created_copy.exists());
    assert!(second.exists());
}
