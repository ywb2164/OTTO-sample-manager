use std::fs;

use otto_sample_manager_lib::audio_metadata::probe_audio_metadata;

#[test]
fn probes_duration_sample_rate_and_channels_without_decoding_the_file() {
    let temp_dir = tempfile::tempdir().expect("create metadata temp directory");
    let audio_path = temp_dir.path().join("metadata.wav");
    fs::write(&audio_path, mono_wav()).expect("write test wav");

    let metadata = probe_audio_metadata(&audio_path);
    assert_eq!(metadata.duration_ms, Some(1_000));
    assert_eq!(metadata.sample_rate, Some(8_000));
    assert_eq!(metadata.channels, Some(1));
}

fn mono_wav() -> Vec<u8> {
    let sample_rate = 8_000_u32;
    let samples = vec![0_i16; sample_rate as usize];
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
