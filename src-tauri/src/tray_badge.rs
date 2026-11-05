//! Tray icon with the mouse battery level as a badge in the bottom-right corner
//! (the "B" variant the user picked). Pure pixel work on RGBA buffers so it is
//! testable without a window.

/// Edge of the composed icon. Windows scales it to the tray's 16/20/24/32 px.
pub const SIZE: u32 = 32;

/// 3×5 pixel digits, one row per byte, three low bits per row (MSB = left).
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
/// Each font pixel is drawn as a SCALE×SCALE block.
const SCALE: u32 = 2;
const BADGE_HEIGHT: u32 = 14;
const TEXT: [u8; 4] = [0x11, 0x11, 0x11, 0xff];

/// Badge colour by level: red ≤ 10 %, amber ≤ 30 %, green above.
fn badge_color(percent: u8) -> [u8; 4] {
    match percent {
        0..=10 => [0xe2, 0x4b, 0x4a, 0xff],
        11..=30 => [0xef, 0x9f, 0x27, 0xff],
        _ => [0x97, 0xc4, 0x59, 0xff],
    }
}

/// `base` (RGBA, `width`×`height`) scaled to [`SIZE`] with the badge drawn on
/// top. Returns RGBA of SIZE×SIZE.
pub fn compose(base: &[u8], width: u32, height: u32, percent: u8) -> Vec<u8> {
    let mut out = downscale(base, width, height);
    let text = percent.min(100).to_string();
    let digit_w = 3 * SCALE;
    let text_w = text.len() as u32 * digit_w + (text.len() as u32 - 1) * SCALE;
    let badge_w = text_w + 2 * SCALE + 2;
    let (bx, by) = (SIZE - badge_w, SIZE - BADGE_HEIGHT);
    fill(&mut out, bx, by, badge_w, BADGE_HEIGHT, badge_color(percent));
    let (mut x, y) = (bx + SCALE + 1, by + (BADGE_HEIGHT - 5 * SCALE) / 2);
    for ch in text.bytes() {
        let glyph = DIGITS[(ch - b'0') as usize];
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    fill(&mut out, x + col * SCALE, y + row as u32 * SCALE, SCALE, SCALE, TEXT);
                }
            }
        }
        x += digit_w + SCALE;
    }
    out
}

fn fill(buf: &mut [u8], x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
    for yy in y..(y + h).min(SIZE) {
        for xx in x..(x + w).min(SIZE) {
            let i = ((yy * SIZE + xx) * 4) as usize;
            buf[i..i + 4].copy_from_slice(&color);
        }
    }
}

/// Box-filter downscale of an RGBA image to SIZE×SIZE (alpha-weighted so
/// transparent edges do not darken).
fn downscale(src: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0u8; (SIZE * SIZE * 4) as usize];
    if width == 0 || height == 0 || src.len() < (width * height * 4) as usize {
        return out;
    }
    for oy in 0..SIZE {
        for ox in 0..SIZE {
            let (x0, x1) = (ox * width / SIZE, ((ox + 1) * width / SIZE).max(ox * width / SIZE + 1));
            let (y0, y1) = (oy * height / SIZE, ((oy + 1) * height / SIZE).max(oy * height / SIZE + 1));
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1.min(height) {
                for sx in x0..x1.min(width) {
                    let i = ((sy * width + sx) * 4) as usize;
                    let alpha = u64::from(src[i + 3]);
                    r += u64::from(src[i]) * alpha;
                    g += u64::from(src[i + 1]) * alpha;
                    b += u64::from(src[i + 2]) * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            let o = ((oy * SIZE + ox) * 4) as usize;
            if let (Some(r), Some(g), Some(b)) = (r.checked_div(a), g.checked_div(a), b.checked_div(a)) {
                out[o] = r as u8;
                out[o + 1] = g as u8;
                out[o + 2] = b as u8;
                out[o + 3] = (a / n.max(1)) as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(buf: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn badge_sits_in_the_corner_with_the_level_colour() {
        let base = vec![0u8; 64 * 64 * 4];
        let low = compose(&base, 64, 64, 5);
        assert_eq!(low.len(), (SIZE * SIZE * 4) as usize);
        assert_eq!(pixel(&low, SIZE - 1, SIZE - 1), badge_color(5), "corner is badge");
        assert_eq!(pixel(&low, 0, 0), [0, 0, 0, 0], "top-left keeps the icon");
        let full = compose(&base, 64, 64, 100);
        assert_eq!(pixel(&full, SIZE - 1, SIZE - 1), badge_color(100));
    }

    #[test]
    fn downscale_keeps_an_opaque_colour() {
        let base: Vec<u8> = [10u8, 20, 30, 255].repeat(256 * 256);
        let out = downscale(&base, 256, 256);
        assert_eq!(pixel(&out, 5, 5), [10, 20, 30, 255]);
    }
}
