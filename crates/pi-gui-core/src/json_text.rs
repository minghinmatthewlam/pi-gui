//! JSON text from JavaScript can hold a lone UTF-16 surrogate escape such as `\ud83d` (half of
//! an emoji cut off by a length limit). `JSON.parse` accepts it; Rust strings cannot hold it.

use std::borrow::Cow;

/// Replaces each unpaired surrogate escape with `�`, the replacement character a screen
/// draws for it anyway. Well-formed text is returned unchanged without copying.
pub fn replace_lone_surrogates(text: &str) -> Cow<'_, str> {
    if !text.contains("\\u") {
        return Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let mut output: Option<String> = None;
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        // Skip any other escape whole, so `\\ud83d` (an escaped backslash) is left alone.
        if bytes.get(index + 1) != Some(&b'u') {
            index += 2;
            continue;
        }
        let Some(unit) = hex_unit(bytes, index + 2) else {
            index += 2;
            continue;
        };
        let paired = (0xd800..0xdc00).contains(&unit)
            && bytes.get(index + 6) == Some(&b'\\')
            && bytes.get(index + 7) == Some(&b'u')
            && hex_unit(bytes, index + 8).is_some_and(|low| (0xdc00..0xe000).contains(&low));
        if paired {
            index += 12;
        } else if (0xd800..0xe000).contains(&unit) {
            let out = output.get_or_insert_with(|| String::with_capacity(text.len()));
            out.push_str(&text[copied..index]);
            out.push_str("\\ufffd");
            index += 6;
            copied = index;
        } else {
            index += 6;
        }
    }
    match output {
        Some(mut out) => {
            out.push_str(&text[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(text),
    }
}

fn hex_unit(bytes: &[u8], start: usize) -> Option<u32> {
    let digits = std::str::from_utf8(bytes.get(start..start + 4)?).ok()?;
    u32::from_str_radix(digits, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::replace_lone_surrogates as fix;

    /// Builds JSON text with `~` standing for a backslash, so the escapes stay readable.
    fn text(source: &str) -> String {
        source.replace('~', "\\")
    }

    #[test]
    fn replaces_only_unpaired_surrogates() {
        let cases = [
            ("\"a~ud83d\"", "\"a~ufffd\""),
            ("\"~ude00x\"", "\"~ufffdx\""),
            ("\"~ud83d~ude00\"", "\"~ud83d~ude00\""),
            ("\"~~ud83d\"", "\"~~ud83d\""),
            (
                "\"~u00e9 ~ud83d~ud83d~ude00\"",
                "\"~u00e9 ~ufffd~ud83d~ude00\"",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(fix(&text(input)), text(expected), "{input}");
        }
        assert!(matches!(fix("plain"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn fixed_text_parses() {
        let value: serde_json::Value = serde_json::from_str(&fix(r#"{"t":"hi \ud83d"}"#)).unwrap();
        assert_eq!(value["t"], "hi \u{fffd}");
    }
}
