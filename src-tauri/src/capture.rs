//! A picture of a screen for `look:snap` (JPEG, a small one) and `files:screenshot` (PNG, full size)
//! (TAURI-07). The platform contract (platform.capture.screen): a Buffer, or null when there is no
//! picture. Nothing here asks for permission or grants it.
//!
//! macOS: CGPreflightScreenCaptureAccess says whether Screen Recording is allowed WITHOUT asking; if
//! not, the answer is "no picture" (null), as Electron's desktopCapturer gives an empty thumbnail,
//! and the core's own message follows ("no picture of the screen"). The image is CGDisplayCreateImage,
//! drawn scaled by CoreGraphics into an RGBA buffer, encoded here. Windows and Linux: not done yet,
//! always "no picture" (TAURI-12 follow-up; the sidecar says so once).

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "png" => Some(Format::Png),
            "jpeg" | "jpg" => Some(Format::Jpeg),
            _ => None,
        }
    }
}

/// The display asked for, as the core knows it (screen DIP, origin top-left of the main display).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub const MAX_SIDE: u32 = 16384;
pub const MAX_PIXELS: u64 = 120_000_000;

/// The size to render: at least 1 px, within what a screen can be.
pub fn clamp_size(width: f64, height: f64) -> Result<(u32, u32), String> {
    if !(width.is_finite() && height.is_finite()) || width < 1.0 || height < 1.0 {
        return Err(format!("bad size {width}x{height}"));
    }
    let (w, h) = (width.round() as u32, height.round() as u32);
    if w > MAX_SIDE || h > MAX_SIDE || (w as u64) * (h as u64) > MAX_PIXELS {
        return Err(format!("size {w}x{h} is too large"));
    }
    Ok((w, h))
}

/// RGBA (opaque or premultiplied; the screen is opaque) to PNG or JPEG.
pub fn encode(rgba: &[u8], width: u32, height: u32, format: Format, quality: u8) -> Result<Vec<u8>, String> {
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("pixel buffer does not match its size".into());
    }
    let mut out = Vec::new();
    match format {
        Format::Png => {
            let mut enc = png::Encoder::new(&mut out, width, height);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Fast);
            let mut w = enc.write_header().map_err(|e| e.to_string())?;
            w.write_image_data(rgba).map_err(|e| e.to_string())?;
            w.finish().map_err(|e| e.to_string())?;
        }
        Format::Jpeg => {
            let (w16, h16) = (u16::try_from(width).map_err(|_| "too wide for JPEG")?, u16::try_from(height).map_err(|_| "too tall for JPEG")?);
            let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
            jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100))
                .encode(&rgb, w16, h16, jpeg_encoder::ColorType::Rgb)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(out)
}

/// The picture of the display at `bounds`, `width` x `height` pixels. Ok(None): no picture (no
/// permission, no such display, not done on this system).
pub fn screen(bounds: Bounds, width: f64, height: f64, format: Format, quality: u8) -> Result<Option<Vec<u8>>, String> {
    let (w, h) = clamp_size(width, height)?;
    match imp::render(bounds, w, h)? {
        Some(rgba) => encode(&rgba, w, h, format, quality).map(Some),
        None => Ok(None),
    }
}

/// Is Screen Recording allowed? Asks nothing. None where there is no such permission to read.
pub fn permitted() -> Option<bool> {
    imp::permitted()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Bounds;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGGetActiveDisplayList(max: u32, ids: *mut u32, count: *mut u32) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(id: u32) -> CGRect;
        fn CGDisplayCreateImage(id: u32) -> *mut c_void;
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, space: *mut c_void, info: u32) -> *mut c_void;
        fn CGContextSetInterpolationQuality(ctx: *mut c_void, quality: i32);
        fn CGContextDrawImage(ctx: *mut c_void, rect: CGRect, image: *mut c_void);
        fn CGContextRelease(ctx: *mut c_void);
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGImageRelease(image: *mut c_void);
    }

    pub fn permitted() -> Option<bool> {
        Some(unsafe { CGPreflightScreenCaptureAccess() })
    }

    /// The active display whose frame is nearest to `want`.
    fn display_for(want: Bounds) -> u32 {
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        unsafe {
            if CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) != 0 || count == 0 {
                return CGMainDisplayID();
            }
            let score = |id: u32| {
                let r = CGDisplayBounds(id);
                (r.origin.x - want.x).abs() + (r.origin.y - want.y).abs() + (r.size.width - want.width).abs() + (r.size.height - want.height).abs()
            };
            ids[..count as usize].iter().copied().min_by(|a, b| score(*a).total_cmp(&score(*b))).unwrap_or_else(|| CGMainDisplayID())
        }
    }

    pub fn render(bounds: Bounds, w: u32, h: u32) -> Result<Option<Vec<u8>>, String> {
        unsafe {
            if !CGPreflightScreenCaptureAccess() {
                return Ok(None);
            }
            let image = CGDisplayCreateImage(display_for(bounds));
            if image.is_null() {
                return Ok(None);
            }
            let (wp, hp) = (w as usize, h as usize);
            let mut buffer = vec![0u8; wp * hp * 4];
            let space = CGColorSpaceCreateDeviceRGB();
            // kCGImageAlphaPremultipliedLast: RGBA, the order the encoders take
            let ctx = CGBitmapContextCreate(buffer.as_mut_ptr().cast(), wp, hp, 8, wp * 4, space, 1);
            let drawn = !ctx.is_null();
            if drawn {
                CGContextSetInterpolationQuality(ctx, 3); // kCGInterpolationHigh
                CGContextDrawImage(ctx, CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: w as f64, height: h as f64 } }, image);
                CGContextRelease(ctx);
            }
            CGColorSpaceRelease(space);
            CGImageRelease(image);
            if !drawn {
                return Err("no bitmap context".into());
            }
            Ok(Some(buffer))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Bounds;

    pub fn permitted() -> Option<bool> {
        None
    }

    pub fn render(_bounds: Bounds, _w: u32, _h: u32) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).flat_map(|i| [(i % w * 255 / w) as u8, (i / w * 255 / h) as u8, 90, 255]).collect()
    }

    #[test]
    fn png_round_trips_and_jpeg_has_its_magic() {
        let rgba = gradient(40, 24);
        let png_bytes = encode(&rgba, 40, 24, Format::Png, 72).unwrap();
        assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n");
        let mut reader = png::Decoder::new(std::io::Cursor::new(&png_bytes)).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (40, 24));
        assert_eq!(&buf[..info.buffer_size()], &rgba[..]);

        let jpg = encode(&rgba, 40, 24, Format::Jpeg, 72).unwrap();
        assert_eq!(&jpg[..2], &[0xff, 0xd8]);
        assert_eq!(&jpg[jpg.len() - 2..], &[0xff, 0xd9]);
    }

    #[test]
    fn a_lower_quality_is_smaller() {
        let rgba = gradient(120, 80);
        let hi = encode(&rgba, 120, 80, Format::Jpeg, 95).unwrap().len();
        let lo = encode(&rgba, 120, 80, Format::Jpeg, 20).unwrap().len();
        assert!(lo < hi, "{lo} < {hi}");
    }

    #[test]
    fn a_wrong_buffer_is_refused() {
        assert!(encode(&[0; 10], 4, 4, Format::Png, 72).is_err());
    }

    #[test]
    fn sizes_are_checked() {
        assert_eq!(clamp_size(1280.4, 800.6).unwrap(), (1280, 801));
        assert!(clamp_size(0.0, 10.0).is_err());
        assert!(clamp_size(f64::NAN, 10.0).is_err());
        assert!(clamp_size(100000.0, 10.0).is_err());
        assert!(clamp_size(15000.0, 15000.0).is_err());
    }

    #[test]
    fn formats() {
        assert_eq!(Format::parse("png"), Some(Format::Png));
        assert_eq!(Format::parse("jpeg"), Some(Format::Jpeg));
        assert_eq!(Format::parse("gif"), None);
    }

    /// Where Screen Recording is not allowed, the answer is "no picture", not a failure and not a prompt.
    /// Where it is (the terminal running the tests was granted it), the picture is checked for its size
    /// only: nothing of it is kept or printed.
    #[test]
    fn the_real_screen_gives_a_picture_or_an_honest_nothing() {
        let r = screen(Bounds { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 }, 320.0, 200.0, Format::Jpeg, 72).unwrap();
        match (permitted(), r) {
            (Some(false), got) => assert!(got.is_none(), "no permission, so no picture"),
            (Some(true), Some(jpg)) => assert_eq!(&jpg[..2], &[0xff, 0xd8]),
            (Some(true), None) => eprintln!("permitted but no display image"),
            (None, got) => assert!(got.is_none()),
        }
    }
}
