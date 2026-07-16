use std::fs::{self, File};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

pub const WAVEFORM_POINTS: usize = 2_400;
const SOURCE_BUCKET_FRAMES: usize = 2_048;
const CACHE_VERSION: u32 = 1;
const CACHE_LIMIT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum WaveformError {
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("audio decode error: {0}")]
    Decode(#[from] SymphoniaError),
    #[error("waveform cache error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("audio track is missing or unsupported")]
    MissingAudioTrack,
    #[error("audio file contains no decoded samples")]
    EmptyAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeaks {
    pub mins: Vec<f32>,
    pub maxs: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WaveformLoad {
    pub peaks: WaveformPeaks,
    pub cache_hit: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedWaveform {
    version: u32,
    key: String,
    peaks: WaveformPeaks,
}

pub fn load_or_create_waveform(
    audio_path: impl AsRef<Path>,
    cache_dir: impl AsRef<Path>,
) -> Result<WaveformLoad, WaveformError> {
    let audio_path = audio_path.as_ref();
    let cache_dir = cache_dir.as_ref();
    let key = cache_key(audio_path)?;
    let cache_path = cache_dir.join(format!("{}.json", sha256_hex(key.as_bytes())));
    if let Ok(bytes) = fs::read(&cache_path) {
        if let Ok(cached) = serde_json::from_slice::<CachedWaveform>(&bytes) {
            if cached.version == CACHE_VERSION && cached.key == key {
                return Ok(WaveformLoad {
                    peaks: cached.peaks,
                    cache_hit: true,
                });
            }
        }
    }

    let peaks = decode_waveform(audio_path)?;
    fs::create_dir_all(cache_dir)?;
    let cached = CachedWaveform {
        version: CACHE_VERSION,
        key,
        peaks: peaks.clone(),
    };
    let temporary_path = cache_path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary_path, serde_json::to_vec(&cached)?)?;
    if cache_path.exists() {
        let _ = fs::remove_file(&cache_path);
    }
    fs::rename(temporary_path, &cache_path)?;
    prune_cache(cache_dir, &cache_path);
    Ok(WaveformLoad {
        peaks,
        cache_hit: false,
    })
}

fn decode_waveform(path: &Path) -> Result<WaveformPeaks, WaveformError> {
    let file = Box::new(File::open(path)?);
    let media_source = MediaSourceStream::new(file, Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let mut format = symphonia::default::get_probe().probe(
        &hint,
        media_source,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or(WaveformError::MissingAudioTrack)?;
    let codec_parameters = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .ok_or(WaveformError::MissingAudioTrack)?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(codec_parameters, &AudioDecoderOptions::default())?;
    let track_id = track.id;
    let mut interleaved = Vec::<f32>::new();
    let mut source_mins = Vec::<f32>::new();
    let mut source_maxs = Vec::<f32>::new();
    let mut bucket_min = 1.0_f32;
    let mut bucket_max = -1.0_f32;
    let mut bucket_frames = 0_usize;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(error.into()),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(error.into()),
        };
        let channels = decoded.spec().channels().count().max(1);
        interleaved.resize(decoded.samples_interleaved(), f32::MID);
        decoded.copy_to_slice_interleaved(&mut interleaved);
        for frame in interleaved.chunks(channels) {
            let sample = frame[0].clamp(-1.0, 1.0);
            bucket_min = bucket_min.min(sample);
            bucket_max = bucket_max.max(sample);
            bucket_frames += 1;
            if bucket_frames == SOURCE_BUCKET_FRAMES {
                source_mins.push(bucket_min);
                source_maxs.push(bucket_max);
                bucket_min = 1.0;
                bucket_max = -1.0;
                bucket_frames = 0;
            }
        }
    }
    if bucket_frames > 0 {
        source_mins.push(bucket_min);
        source_maxs.push(bucket_max);
    }
    if source_mins.is_empty() {
        return Err(WaveformError::EmptyAudio);
    }
    Ok(resample_peaks(&source_mins, &source_maxs))
}

fn resample_peaks(source_mins: &[f32], source_maxs: &[f32]) -> WaveformPeaks {
    let source_len = source_mins.len();
    let mut mins = Vec::with_capacity(WAVEFORM_POINTS);
    let mut maxs = Vec::with_capacity(WAVEFORM_POINTS);
    for index in 0..WAVEFORM_POINTS {
        let start = index * source_len / WAVEFORM_POINTS;
        let end = (((index + 1) * source_len / WAVEFORM_POINTS).max(start + 1)).min(source_len);
        let mut min = 1.0_f32;
        let mut max = -1.0_f32;
        for source_index in start..end {
            min = min.min(source_mins[source_index]);
            max = max.max(source_maxs[source_index]);
        }
        mins.push(min);
        maxs.push(max);
    }
    WaveformPeaks { mins, maxs }
}

fn cache_key(path: &Path) -> Result<String, std::io::Error> {
    let metadata = fs::metadata(path)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    Ok(format!(
        "v{CACHE_VERSION}:{}:{}:{modified}",
        path.to_string_lossy().replace('/', "\\").to_lowercase(),
        metadata.len(),
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn prune_cache(cache_dir: &Path, protected_path: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    entry.path(),
                    metadata.len(),
                    metadata.modified().unwrap_or(UNIX_EPOCH),
                )
            })
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, length, _)| length).sum::<u64>();
    if total <= CACHE_LIMIT_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, length, _) in files {
        if total <= CACHE_LIMIT_BYTES {
            break;
        }
        if path == protected_path {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(length);
        }
    }
}
