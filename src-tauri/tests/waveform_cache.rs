use std::fs;

use otto_sample_manager_lib::waveform_cache::{WAVEFORM_POINTS, load_or_create_waveform};

#[test]
fn waveform_is_chunk_decoded_to_fixed_peaks_and_reused_from_disk() {
    let temp_dir = tempfile::tempdir().expect("create waveform temp directory");
    let audio_path = temp_dir.path().join("tone.wav");
    let cache_dir = temp_dir.path().join("waveforms");
    fs::write(&audio_path, mono_wav()).expect("write test wav");

    let first = load_or_create_waveform(&audio_path, &cache_dir).expect("decode waveform");
    assert!(!first.cache_hit);
    assert_eq!(first.peaks.mins.len(), WAVEFORM_POINTS);
    assert_eq!(first.peaks.maxs.len(), WAVEFORM_POINTS);
    assert!(first.peaks.maxs.iter().any(|value| *value > 0.4));
    assert!(first.peaks.mins.iter().any(|value| *value < -0.4));

    let second = load_or_create_waveform(&audio_path, &cache_dir).expect("load cached waveform");
    assert!(second.cache_hit);
    assert_eq!(second.peaks, first.peaks);
}

fn mono_wav() -> Vec<u8> {
    let sample_rate = 8_000_u32;
    let samples = (0..8_000)
        .map(|index| {
            if index % 32 < 16 {
                20_000_i16
            } else {
                -20_000_i16
            }
        })
        .collect::<Vec<_>>();
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}
