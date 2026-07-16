#![cfg(windows)]

use std::fs;
use std::path::PathBuf;
use std::ptr;

use otto_sample_manager_lib::native_drag::create_file_data_object;
use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::Ole::{CF_HDROP, OleInitialize, OleUninitialize, ReleaseStgMedium};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

#[test]
fn shell_data_object_contains_readable_non_empty_paths_as_cf_hdrop() {
    let temp_dir = tempfile::tempdir().expect("create native drag directory");
    let first = temp_dir.path().join("中文 sample one.wav");
    let second = temp_dir.path().join("sample two.wav");
    fs::write(&first, b"one").expect("write first sample");
    fs::write(&second, b"two").expect("write second sample");

    unsafe { OleInitialize(None).expect("initialize OLE") };
    let data_object = create_file_data_object(&[first.clone(), second.clone()])
        .expect("create shell data object");
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let mut medium = unsafe { data_object.GetData(&format) }.expect("read CF_HDROP payload");
    assert_eq!(medium.tymed, TYMED_HGLOBAL.0 as u32);
    let hdrop = HDROP(unsafe { medium.u.hGlobal }.0);
    let file_count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    assert_eq!(file_count, 2, "CF_HDROP should contain both files");

    let read_path = |index| {
        let character_count = unsafe { DragQueryFileW(hdrop, index, None) };
        assert!(character_count > 0, "path {index} must not be empty");
        let mut buffer = vec![0_u16; character_count as usize + 1];
        let copied = unsafe { DragQueryFileW(hdrop, index, Some(&mut buffer)) };
        assert_eq!(copied, character_count);
        PathBuf::from(String::from_utf16(&buffer[..copied as usize]).expect("decode path"))
    };
    let extracted = [read_path(0), read_path(1)];
    for path in &extracted {
        assert!(
            path.is_file(),
            "dragged path must exist: {}",
            path.display()
        );
        assert!(
            fs::metadata(path).expect("read dragged metadata").len() > 0,
            "dragged file must not be empty: {}",
            path.display()
        );
    }
    assert_eq!(extracted, [first, second]);
    unsafe { ReleaseStgMedium(&mut medium) };
    unsafe { OleUninitialize() };
}

#[test]
fn shell_data_object_rejects_empty_missing_directory_and_zero_byte_inputs() {
    let temp_dir = tempfile::tempdir().expect("create native drag directory");
    let missing = temp_dir.path().join("missing.wav");
    let zero_byte = temp_dir.path().join("zero.wav");
    fs::write(&zero_byte, []).expect("write zero-byte fixture");

    assert!(create_file_data_object(&[]).is_err());
    assert!(create_file_data_object(&[missing]).is_err());
    assert!(create_file_data_object(&[temp_dir.path().to_path_buf()]).is_err());
    assert!(create_file_data_object(&[zero_byte]).is_err());
}
