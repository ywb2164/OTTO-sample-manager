use std::fs::File;
use std::path::Path;

use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Timestamp;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AudioMetadata {
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
}

pub fn probe_audio_metadata(path: impl AsRef<Path>) -> AudioMetadata {
    try_probe_audio_metadata(path.as_ref()).unwrap_or_default()
}

fn try_probe_audio_metadata(path: &Path) -> Option<AudioMetadata> {
    let file = Box::new(File::open(path).ok()?);
    let media_source = MediaSourceStream::new(file, Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let format = symphonia::default::get_probe()
        .probe(
            &hint,
            media_source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = format.default_track(TrackType::Audio)?;
    let parameters = track.codec_params.as_ref()?.audio()?;
    let sample_rate = parameters.sample_rate.map(i64::from);
    let channels = parameters
        .channels
        .as_ref()
        .map(|value| value.count().min(i64::MAX as usize) as i64);
    let duration_ms = track
        .time_base
        .zip(track.duration)
        .and_then(|(time_base, duration)| {
            let ticks = i64::try_from(duration.get()).ok()?;
            let millis = time_base.calc_time(Timestamp::new(ticks))?.as_millis();
            i64::try_from(millis).ok()
        })
        .or_else(|| {
            let frames = track.num_frames?;
            let rate = parameters.sample_rate?;
            Some(
                frames
                    .saturating_mul(1_000)
                    .checked_div(u64::from(rate))?
                    .min(i64::MAX as u64) as i64,
            )
        });

    Some(AudioMetadata {
        duration_ms,
        sample_rate,
        channels,
    })
}
