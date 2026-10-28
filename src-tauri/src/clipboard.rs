//! The clipboard (TAURI-07): her report card's copy button puts a PNG there (`panel:copy`,
//! platform.clipboard.writeImage); text is here too (writeText), for the shell's own use and the tests.
//! arboard does the system part: NSPasteboard, the Windows clipboard, X11 / Wayland.
//!
//! The tests never touch the real clipboard (it is the user's): a fake stands in. One opt-in live
//! check keeps and puts back the text that was there (CAPRI_LIVE_CLIPBOARD=1).

use std::borrow::Cow;

/// What this module needs of a clipboard.
pub trait Board {
    fn set_text(&mut self, text: &str) -> Result<(), String>;
    fn set_image(&mut self, width: usize, height: usize, rgba: &[u8]) -> Result<(), String>;
}

pub struct System(arboard::Clipboard);

impl System {
    pub fn open() -> Result<System, String> {
        arboard::Clipboard::new().map(System).map_err(|e| e.to_string())
    }
    #[cfg(test)]
    pub fn text(&mut self) -> Option<String> {
        self.0.get_text().ok()
    }
}

impl Board for System {
    fn set_text(&mut self, text: &str) -> Result<(), String> {
        self.0.set_text(text.to_string()).map_err(|e| e.to_string())
    }
    fn set_image(&mut self, width: usize, height: usize, rgba: &[u8]) -> Result<(), String> {
        self.0
            .set_image(arboard::ImageData { width, height, bytes: Cow::Borrowed(rgba) })
            .map_err(|e| e.to_string())
    }
}

const MAX_PIXELS: usize = 100_000_000;

/// A PNG as 8-bit RGBA: (width, height, bytes).
pub fn decode_png(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| format!("not a PNG: {e}"))?;
    let (w, h) = (reader.info().width as usize, reader.info().height as usize);
    if w == 0 || h == 0 || w.saturating_mul(h) > MAX_PIXELS {
        return Err(format!("picture {w}x{h} is not a size to copy"));
    }
    let mut buf = vec![0; reader.output_buffer_size().ok_or("picture too large")?];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("bad PNG: {e}"))?;
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Indexed => return Err("palette PNG was not expanded".into()),
    };
    if rgba.len() != w * h * 4 {
        return Err("PNG pixels do not match its size".into());
    }
    Ok((w, h, rgba))
}

#[cfg(test)]
pub fn write_png(board: &mut dyn Board, png_bytes: &[u8]) -> Result<(), String> {
    let (w, h, rgba) = decode_png(png_bytes)?;
    board.set_image(w, h, &rgba)
}

pub fn write_text(board: &mut dyn Board, text: &str) -> Result<(), String> {
    board.set_text(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        text: Option<String>,
        image: Option<(usize, usize, Vec<u8>)>,
    }

    impl Board for Fake {
        fn set_text(&mut self, t: &str) -> Result<(), String> {
            self.text = Some(t.into());
            Ok(())
        }
        fn set_image(&mut self, w: usize, h: usize, b: &[u8]) -> Result<(), String> {
            self.image = Some((w, h, b.to_vec()));
            Ok(())
        }
    }

    fn png_of(color: png::ColorType, w: u32, h: u32, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut e = png::Encoder::new(&mut out, w, h);
        e.set_color(color);
        e.set_depth(png::BitDepth::Eight);
        let mut wr = e.write_header().unwrap();
        wr.write_image_data(data).unwrap();
        wr.finish().unwrap();
        out
    }

    #[test]
    fn an_rgba_png_goes_to_the_board_as_it_is() {
        let px: Vec<u8> = vec![255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255];
        let mut f = Fake::default();
        write_png(&mut f, &png_of(png::ColorType::Rgba, 2, 2, &px)).unwrap();
        assert_eq!(f.image, Some((2, 2, px)));
    }

    #[test]
    fn rgb_and_grey_pngs_get_an_alpha() {
        let (w, h, a) = decode_png(&png_of(png::ColorType::Rgb, 1, 2, &[1, 2, 3, 4, 5, 6])).unwrap();
        assert_eq!((w, h, a), (1, 2, vec![1, 2, 3, 255, 4, 5, 6, 255]));
        let (_, _, g) = decode_png(&png_of(png::ColorType::Grayscale, 2, 1, &[10, 20])).unwrap();
        assert_eq!(g, vec![10, 10, 10, 255, 20, 20, 20, 255]);
    }

    #[test]
    fn what_is_not_a_png_is_refused_and_the_board_is_left_alone() {
        let mut f = Fake::default();
        assert!(write_png(&mut f, b"GIF89a....").is_err());
        assert!(write_png(&mut f, &[]).is_err());
        assert!(f.image.is_none() && f.text.is_none());
    }

    #[test]
    fn text_goes_through() {
        let mut f = Fake::default();
        write_text(&mut f, "hello").unwrap();
        assert_eq!(f.text.as_deref(), Some("hello"));
    }

    /// Opt-in (it uses the real clipboard): the text that is there is kept and put back.
    #[test]
    fn live_text_round_trip_restores_the_clipboard() {
        if std::env::var_os("CAPRI_LIVE_CLIPBOARD").is_none() {
            eprintln!("skipped: set CAPRI_LIVE_CLIPBOARD=1 to try the real clipboard");
            return;
        }
        let mut board = System::open().expect("clipboard");
        let before = board.text();
        let probe = "capri-clipboard-probe-7f3a";
        write_text(&mut board, probe).unwrap();
        let read = board.text();
        // put back what was there (an empty string if it held no text)
        let restored = write_text(&mut board, before.as_deref().unwrap_or(""));
        assert_eq!(read.as_deref(), Some(probe));
        restored.unwrap();
        assert_eq!(board.text().unwrap_or_default(), before.unwrap_or_default());
    }
}
