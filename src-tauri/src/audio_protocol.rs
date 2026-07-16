use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{Request, Response, StatusCode, header};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

use crate::commands::DesktopState;

const MAX_STREAM_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

pub fn handle(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let sample_id = request.uri().path().trim_start_matches('/').to_owned();
    let full_response = request
        .uri()
        .query()
        .map(|query| query.split('&').any(|item| item == "full=1"))
        .unwrap_or(false);
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let is_head = request.method() == tauri::http::Method::HEAD;

    std::thread::spawn(move || {
        let response = serve_audio(&app, &sample_id, range.as_deref(), is_head, full_response)
            .unwrap_or_else(error_response);
        responder.respond(response);
    });
}

fn serve_audio(
    app: &tauri::AppHandle,
    sample_id: &str,
    range_header: Option<&str>,
    is_head: bool,
    full_response: bool,
) -> Result<Response<Vec<u8>>, String> {
    let state = app.state::<DesktopState>();
    let path = state
        .read(|database| database.sample_path(sample_id))?
        .ok_or_else(|| "sample not found".to_owned())?;
    let mut file = File::open(&path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&path))
            .header(header::CONTENT_LENGTH, "0")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .map_err(|error| error.to_string());
    }

    let (start, end, status) = match response_window(range_header, length, is_head, full_response) {
        Ok(window) => window,
        Err(()) => return range_not_satisfiable(length),
    };
    let response_length = end.saturating_sub(start).saturating_add(1);
    let mut body = if is_head {
        Vec::new()
    } else {
        let allocation = usize::try_from(response_length)
            .map_err(|_| "requested audio range is too large".to_owned())?;
        let mut buffer = vec![0; allocation];
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        file.read_exact(&mut buffer)
            .map_err(|error| error.to_string())?;
        buffer
    };
    if is_head {
        body.clear();
    }

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type(&path))
        .header(header::CONTENT_LENGTH, response_length.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "private, max-age=3600");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    builder.body(body).map_err(|error| error.to_string())
}

fn response_window(
    range_header: Option<&str>,
    length: u64,
    is_head: bool,
    full_response: bool,
) -> Result<(u64, u64, StatusCode), ()> {
    Ok(match range_header {
        Some(value) => {
            let (start, requested_end) = parse_range(value, length).ok_or(())?;
            let end = requested_end.min(
                start
                    .saturating_add(MAX_STREAM_CHUNK_BYTES)
                    .saturating_sub(1),
            );
            (start, end, StatusCode::PARTIAL_CONTENT)
        }
        None if full_response || is_head => (0, length - 1, StatusCode::OK),
        None => (
            0,
            (length - 1).min(MAX_STREAM_CHUNK_BYTES - 1),
            StatusCode::PARTIAL_CONTENT,
        ),
    })
}

fn range_not_satisfiable(length: u64) -> Result<Response<Vec<u8>>, String> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{length}"))
        .header(header::CONTENT_LENGTH, "0")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .map_err(|error| error.to_string())
}

fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    let first = value.split(',').next()?;
    let (start, end) = first.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(length);
        if suffix == 0 {
            return None;
        }
        return Some((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    (end >= start).then_some((start, end))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("aif") | Some("aiff") => "audio/aiff",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn error_response(error: String) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(error.into_bytes())
        .expect("valid audio error response")
}

#[cfg(test)]
mod tests {
    use tauri::http::StatusCode;

    use super::{MAX_STREAM_CHUNK_BYTES, parse_range, response_window};

    #[test]
    fn parses_bounded_open_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=-0", 100), None);
    }

    #[test]
    fn caps_media_chunks_but_keeps_explicit_short_file_reads_complete() {
        let length = MAX_STREAM_CHUNK_BYTES * 3;
        assert_eq!(
            response_window(Some("bytes=0-"), length, false, false),
            Ok((0, MAX_STREAM_CHUNK_BYTES - 1, StatusCode::PARTIAL_CONTENT)),
        );
        assert_eq!(
            response_window(None, length, false, false),
            Ok((0, MAX_STREAM_CHUNK_BYTES - 1, StatusCode::PARTIAL_CONTENT)),
        );
        assert_eq!(
            response_window(None, length, false, true),
            Ok((0, length - 1, StatusCode::OK)),
        );
        assert_eq!(
            response_window(Some("bytes=999-"), 100, false, false),
            Err(())
        );
    }
}
