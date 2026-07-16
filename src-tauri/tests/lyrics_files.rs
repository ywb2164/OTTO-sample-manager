use std::fs;

use otto_sample_manager_lib::lyrics_files::{
    LyricsFileItem, LyricsFilesPayload, create_lyrics_files, read_lyrics_text,
};

#[test]
fn reads_only_bounded_text_and_keeps_unicode_lyrics_copies_under_the_copy_root() {
    let temp = tempfile::tempdir().expect("temporary lyrics root");
    let text = temp.path().join("歌词.txt");
    fs::write(&text, "你 好").expect("write text");
    assert_eq!(
        read_lyrics_text(&text).expect("read text"),
        "你 好".as_bytes()
    );

    let source = temp.path().join("中文 source.wav");
    fs::write(&source, b"audio").expect("write source");
    let result = create_lyrics_files(
        temp.path().join("Copy"),
        &LyricsFilesPayload {
            target_group_name: "目标:/组".to_owned(),
            items: vec![
                LyricsFileItem {
                    id: "one".to_owned(),
                    source_path: source,
                    file_name: "001 你.wav".to_owned(),
                },
                LyricsFileItem {
                    id: "missing".to_owned(),
                    source_path: temp.path().join("missing.wav"),
                    file_name: "002 好.wav".to_owned(),
                },
            ],
        },
    );

    assert_eq!(result.success.len(), 1);
    assert!(result.success[0].target_path.is_file());
    assert!(
        result.success[0]
            .target_path
            .starts_with(temp.path().join("Copy").join("lyrics-assemblies"))
    );
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].reason, "source-missing");
}
