use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use otto_sample_manager_lib::import_pipeline::{AUDIO_EXTENSIONS, scan_audio_files};

#[test]
fn scanner_batches_audio_paths_and_honors_cancellation_between_entries() {
    let temp_dir = tempfile::tempdir().expect("create scan root");
    let nested = temp_dir.path().join("nested");
    fs::create_dir(&nested).expect("create nested directory");
    for index in 0..520 {
        let extension = AUDIO_EXTENSIONS[index % AUDIO_EXTENSIONS.len()];
        fs::write(nested.join(format!("sample-{index}.{extension}")), b"audio")
            .expect("create audio file");
    }
    fs::write(nested.join("ignore.txt"), b"not audio").expect("create ignored file");

    let cancel = Arc::new(AtomicBool::new(false));
    let mut batch_sizes = Vec::new();
    let summary = scan_audio_files(temp_dir.path(), Arc::clone(&cancel), 256, |batch| {
        batch_sizes.push(batch.len());
        Ok(())
    })
    .expect("scan complete tree");

    assert!(!summary.cancelled);
    assert_eq!(summary.discovered, 520);
    assert_eq!(batch_sizes, vec![256, 256, 8]);

    let cancel = Arc::new(AtomicBool::new(false));
    let cancellation_signal = Arc::clone(&cancel);
    let mut delivered = 0;
    let cancelled = scan_audio_files(temp_dir.path(), cancel, 256, |batch| {
        delivered += batch.len();
        cancellation_signal.store(true, Ordering::Release);
        Ok(())
    })
    .expect("cancel scan");
    assert!(cancelled.cancelled);
    assert_eq!(delivered, 256);
    assert_eq!(cancelled.discovered, 256);
}
