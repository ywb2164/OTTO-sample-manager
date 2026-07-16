use std::hint::black_box;
use std::time::Instant;

use otto_sample_manager_lib::library_db::{LibraryDatabase, LibraryQuery, NewSampleRecord};

fn main() {
    let requested = std::env::args()
        .skip(1)
        .filter_map(|value| value.parse::<usize>().ok())
        .collect::<Vec<_>>();
    let sizes = if requested.is_empty() {
        vec![1_000, 10_000, 50_000]
    } else {
        requested
    };

    println!("samples,insert_ms,warm_first_page_p95_ms,index_stream_ms");
    for size in sizes {
        run(size);
    }
}

fn run(size: usize) {
    let temporary = tempfile::tempdir().expect("temporary benchmark directory");
    let database = LibraryDatabase::open(temporary.path().join("library.sqlite3"))
        .expect("open benchmark database");
    database.migrate().expect("migrate benchmark database");
    database
        .create_import_session("benchmark", "D:/synthetic", None)
        .expect("create benchmark session");

    let insert_started = Instant::now();
    for batch_start in (0..size).step_by(500) {
        let batch_end = (batch_start + 500).min(size);
        let records = (batch_start..batch_end)
            .map(|index| NewSampleRecord {
                id: format!("sample-{index:06}"),
                folder_id: None,
                file_path: format!("D:/synthetic/{index:06}-中文 kick sample.wav"),
                file_name: format!("{index:06}-中文 kick sample"),
                extension: ".wav".to_owned(),
                file_size: 48_000,
                imported_at: index as i64,
                duration_ms: Some(1_000),
                sample_rate: Some(48_000),
                channels: Some(1),
            })
            .collect::<Vec<_>>();
        database
            .insert_import_batch("benchmark", &records)
            .expect("insert benchmark batch");
    }
    database
        .commit_import_session("benchmark")
        .expect("commit benchmark session");
    let insert_ms = insert_started.elapsed().as_secs_f64() * 1_000.0;

    let mut page_timings = (0..40)
        .map(|_| {
            let started = Instant::now();
            black_box(
                database
                    .query_page(&LibraryQuery {
                        offset: 0,
                        limit: 100,
                        folder_id: None,
                        group_id: None,
                    })
                    .expect("query first page"),
            );
            started.elapsed().as_secs_f64() * 1_000.0
        })
        .collect::<Vec<_>>();
    page_timings.sort_by(f64::total_cmp);
    let p95_index = ((page_timings.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(page_timings.len() - 1);

    let index_started = Instant::now();
    let mut offset = 0;
    loop {
        let batch = database
            .search_document_batch(offset, 1_000)
            .expect("stream search documents");
        black_box(&batch.documents);
        let Some(next_offset) = batch.next_offset else {
            break;
        };
        offset = next_offset;
    }
    let index_ms = index_started.elapsed().as_secs_f64() * 1_000.0;

    println!(
        "{size},{insert_ms:.2},{:.2},{index_ms:.2}",
        page_timings[p95_index]
    );
}
