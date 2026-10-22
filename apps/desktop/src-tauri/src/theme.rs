//! The native window colour, `windowBackgroundFor` in `contracts/theme.ts`: the `--window`
//! token of the theme preset, so load, reload and resize never flash another theme's colour.

use tauri::window::Color;

/// Each preset's light and dark surface and ink seeds, as `themePresets` lists them; the
/// first is the fallback for an unknown id.
const PRESETS: &[(&str, [(&str, &str); 2])] = &[
    ("default", [("#ffffff", "#282825"), ("#1d1d1c", "#eeeeea")]),
    (
        "catppuccin",
        [("#eff1f5", "#4c4f69"), ("#1e1e2e", "#cdd6f4")],
    ),
    (
        "tokyo-night",
        [("#d5d6db", "#343b58"), ("#1a1b26", "#c0caf5")],
    ),
    ("nord", [("#eceff4", "#2e3440"), ("#2e3440", "#eceff4")]),
    ("dracula", [("#fffbeb", "#1f1f1f"), ("#282a36", "#f8f8f2")]),
    ("gruvbox", [("#fbf1c7", "#3c3836"), ("#282828", "#ebdbb2")]),
    ("github", [("#ffffff", "#1f2328"), ("#0d1117", "#e6edf3")]),
    ("vscode", [("#ffffff", "#1f1f1f"), ("#1e1e1e", "#d4d4d4")]),
];

fn parse_hex(hex: &str) -> [f64; 3] {
    let value = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    [
        f64::from((value >> 16) & 255),
        f64::from((value >> 8) & 255),
        f64::from(value & 255),
    ]
}

/// `mix`: `amount` of the way from `from` to `to`, in sRGB, rounded per channel.
fn mix(from: &str, to: &str, amount: f64) -> [u8; 3] {
    let (from, to) = (parse_hex(from), parse_hex(to));
    std::array::from_fn(|channel| {
        (from[channel] + (to[channel] - from[channel]) * amount).round() as u8
    })
}

/// The window colour for a preset and resolved theme (`"light"` or `"dark"`).
pub fn window_background(preset_id: &str, dark: bool) -> Color {
    let (_, variants) = PRESETS
        .iter()
        .find(|(id, _)| *id == preset_id)
        .unwrap_or(&PRESETS[0]);
    let (surface, ink) = variants[usize::from(dark)];
    // Light windows are the surface tinted toward the ink; dark ones sink toward black.
    let [red, green, blue] = if dark {
        mix(surface, "#000000", 0.28)
    } else {
        mix(surface, ink, 0.07)
    };
    Color(red, green, blue, 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(color: Color) -> String {
        format!("#{:02x}{:02x}{:02x}", color.0, color.1, color.2)
    }

    #[test]
    fn matches_the_renderer_tokens() {
        // `windowBackgroundFor(id, "light" | "dark")` for every preset.
        let expected = [
            ("default", "#f0f0f0", "#151514"),
            ("catppuccin", "#e4e6eb", "#161621"),
            ("tokyo-night", "#cacbd2", "#13131b"),
            ("nord", "#dfe2e7", "#21252e"),
            ("dracula", "#efecdd", "#1d1e27"),
            ("gruvbox", "#eee4bd", "#1d1d1d"),
            ("github", "#eff0f0", "#090c11"),
            ("vscode", "#efefef", "#161616"),
        ];
        for (id, light, dark) in expected {
            assert_eq!(hex(window_background(id, false)), light, "{id} light");
            assert_eq!(hex(window_background(id, true)), dark, "{id} dark");
        }
        assert_eq!(hex(window_background("unknown", true)), "#151514");
    }
}
