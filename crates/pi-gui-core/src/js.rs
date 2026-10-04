//! JavaScript behaviour the saved files depend on: how `JSON.stringify` writes numbers and
//! indents, the order `Object.keys` lists keys in, what `String.prototype.trim` removes, string
//! length in UTF-16 units, `encodeURIComponent`, and the ISO subset of `Date.parse`.

use serde_json::{Map, Number, Value};

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(0));
    out
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None);
    out
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent.map(|depth| depth + 1));
                write_value(out, item, indent.map(|depth| depth + 1));
            }
            newline(out, indent);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent.map(|depth| depth + 1));
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent.map(|depth| depth + 1));
            }
            newline(out, indent);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<usize>) {
    if let Some(depth) = indent {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    }
}

fn write_string(out: &mut String, text: &str) {
    // serde_json escapes exactly the characters `JSON.stringify` does, the same way.
    out.push_str(&serde_json::to_string(text).expect("a string always encodes"));
}

/// A number as JavaScript prints it: `1e+21`, `5e-7`, `0` for `-0`, no `.0` on whole numbers.
pub fn number_text(number: &Number) -> String {
    const SAFE: u64 = (1 << 53) - 1;
    if let Some(value) = number.as_u64().filter(|value| *value <= SAFE) {
        return value.to_string();
    }
    if let Some(value) = number.as_i64().filter(|value| value.unsigned_abs() <= SAFE) {
        return value.to_string();
    }
    float_text(number.as_f64().unwrap_or(f64::NAN))
}

fn float_text(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    // Shortest round-trip digits, then laid out with Number.prototype.toString's rules.
    let mut buffer = ryu::Buffer::new();
    let shortest = buffer.format_finite(value.abs());
    let (mantissa, exponent) = match shortest.split_once('e') {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().unwrap_or(0)),
        None => (shortest, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let joined = format!("{whole}{fraction}");
    let leading = joined.len() - joined.trim_start_matches('0').len();
    let digits = joined.trim_start_matches('0').trim_end_matches('0');
    // The value is 0.digits × 10^point.
    let point = whole.len() as i32 - leading as i32 + exponent;
    let count = digits.len() as i32;
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    if count <= point && point <= 21 {
        out.push_str(digits);
        out.extend(std::iter::repeat_n('0', (point - count) as usize));
    } else if 0 < point && point <= 21 {
        out.push_str(&digits[..point as usize]);
        out.push('.');
        out.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(digits);
    } else {
        out.push_str(&digits[..1]);
        if count > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let shown = point - 1;
        out.push('e');
        out.push(if shown < 0 { '-' } else { '+' });
        out.push_str(&shown.abs().to_string());
    }
    out
}

/// An object's entries in `Object.keys` order: keys that are array indexes first, in
/// numeric order, then the rest in insertion order.
pub fn entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut named = Vec::new();
    for entry in map {
        match array_index(entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(named)
        .collect()
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// `String.prototype.trim`: ECMAScript white space and line terminators, which differ from
/// Rust's `trim` (JavaScript trims U+FEFF but not U+0085).
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// A string's `length` in JavaScript.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`; `None` where JavaScript throws a `URIError`.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Milliseconds JavaScript dates can reach either side of 1970.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// `Date.parse` for the ISO forms JavaScript reads (`2026-09-21`, `2026-09-21T12:00Z`,
/// `+002026-09-21T12:00:00.000+05:30`, ...). Like V8, a day past the month's end rolls over
/// and a time without an offset is local time. Other date text is not read (`None`), where
/// V8 would also try its older free-form formats.
pub fn date_parse(text: &str) -> Option<i64> {
    let mut cursor = Cursor {
        text: text.as_bytes(),
        at: 0,
    };
    let year = match cursor.peek() {
        Some(sign @ (b'+' | b'-')) => {
            cursor.at += 1;
            let year = cursor.digits(6)?;
            if sign == b'-' && year == 0 {
                return None;
            }
            if sign == b'-' {
                -year
            } else {
                year
            }
        }
        _ => cursor.digits(4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if cursor.eat(b'-') {
        month = cursor.digits(2)?;
        if cursor.eat(b'-') {
            day = cursor.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut time_ms = 0;
    let mut offset_ms = Some(0);
    if matches!(cursor.peek(), Some(b'T' | b't')) {
        cursor.at += 1;
        let hour = cursor.digits(2)?;
        if !cursor.eat(b':') {
            return None;
        }
        let minute = cursor.digits(2)?;
        let mut second = 0;
        let mut millis = 0;
        if cursor.eat(b':') {
            second = cursor.digits(2)?;
            if cursor.eat(b'.') {
                let start = cursor.at;
                while cursor.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    cursor.at += 1;
                }
                let fraction = &text[start..cursor.at];
                if fraction.is_empty() {
                    return None;
                }
                millis = format!("{:0<3}", &fraction[..fraction.len().min(3)])
                    .parse::<i64>()
                    .ok()?;
            }
        }
        let valid_clock = hour < 24 && minute < 60 && second < 60;
        let midnight_end = hour == 24 && minute == 0 && second == 0 && millis == 0;
        if !valid_clock && !midnight_end {
            return None;
        }
        time_ms = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        offset_ms = match cursor.peek() {
            Some(b'Z' | b'z') => {
                cursor.at += 1;
                Some(0)
            }
            Some(sign @ (b'+' | b'-')) => {
                cursor.at += 1;
                let hours = cursor.digits(2)?;
                cursor.eat(b':');
                let minutes = cursor.digits(2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let offset = (hours * 60 + minutes) * 60_000;
                Some(if sign == b'+' { offset } else { -offset })
            }
            _ => None,
        };
    }
    if cursor.at != text.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let local_ms = days * 86_400_000 + time_ms;
    let utc_ms = match offset_ms {
        Some(offset) => local_ms - offset,
        None => local_ms - local_offset_ms(local_ms)?,
    };
    (utc_ms.abs() <= MAX_TIME_MS).then_some(utc_ms)
}

/// The local time zone's offset at a local wall-clock time, in milliseconds.
fn local_offset_ms(local_ms: i64) -> Option<i64> {
    use chrono::{Local, LocalResult, Offset, TimeZone};
    let naive = chrono::DateTime::from_timestamp_millis(local_ms)?.naive_utc();
    let offset = match Local.offset_from_local_datetime(&naive) {
        LocalResult::Single(offset) | LocalResult::Ambiguous(offset, _) => offset,
        // A time skipped by a clock change: V8 reads it with the offset from before it.
        LocalResult::None => Local.offset_from_utc_datetime(&naive),
    };
    Some(i64::from(offset.fix().local_minus_utc()) * 1000)
}

/// `new Date(ms).toISOString()`.
pub fn to_iso_string(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

struct Cursor<'a> {
    text: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.at += 1;
        }
        found
    }

    fn digits(&mut self, count: usize) -> Option<i64> {
        let slice = self.text.get(self.at..self.at + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        std::str::from_utf8(slice).ok()?.parse().ok()
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        let cases = [
            (json!(0), "0"),
            (json!(-0.0), "0"),
            (json!(3.0), "3"),
            (json!(1.5), "1.5"),
            (json!(1e21), "1e+21"),
            (json!(1e20), "100000000000000000000"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(5e-7), "5e-7"),
            (json!(0.000001), "0.000001"),
            (json!(-1.25e-10), "-1.25e-10"),
            (json!(1.7976931348623157e308), "1.7976931348623157e+308"),
            (json!(12345678901234567890u64), "12345678901234567000"),
            (json!(-42), "-42"),
        ];
        for (value, expected) in cases {
            assert_eq!(stringify(&value), expected, "{value}");
        }
    }

    #[test]
    fn pretty_output_matches_json_stringify() {
        let value = json!({ "b": [1, { "x": [] }], "a": {}, "2": "two", "1": null });
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"1\": null,\n  \"2\": \"two\",\n  \"b\": [\n    1,\n    {\n      \"x\": []\n    }\n  ],\n  \"a\": {}\n}"
        );
        assert_eq!(
            stringify(&json!(["a\u{1}\n", "é"])),
            "[\"a\\u0001\\n\",\"é\"]"
        );
    }

    #[test]
    fn trims_javascript_white_space() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn uri_components_round_trip() {
        let key = "ws:sess/ü (1)";
        let encoded = encode_uri_component(key);
        assert_eq!(encoded, "ws%3Asess%2F%C3%BC%20(1)");
        assert_eq!(decode_uri_component(&encoded).as_deref(), Some(key));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%C3"), None);
    }

    #[test]
    fn parses_iso_dates_like_v8() {
        let utc = [
            ("2026-02-31T00:00:00Z", Some(1772496000000)),
            ("2026-01-01", Some(1767225600000)),
            ("2026-01", Some(1767225600000)),
            ("2026", Some(1767225600000)),
            ("+002026-01-01T00:00:00Z", Some(1767225600000)),
            ("2026-01-01T24:00:00Z", Some(1767312000000)),
            ("2026-01-01T24:00:01Z", None),
            ("2026-01-01T10:00Z", Some(1767261600000)),
            ("2026-01-01T10:00:00.1234Z", Some(1767261600123)),
            ("2026-01-01T10:00:00.1Z", Some(1767261600100)),
            ("2026-01-01t10:00:00z", Some(1767261600000)),
            ("2026-01-01T10:00:00+0530", Some(1767241800000)),
            ("2026-01-01T10:00:00+05:30", Some(1767241800000)),
            ("-000000-01-01T00:00:00Z", None),
            ("2026-13-01", None),
            ("2026-01-01T10:00:00.Z", None),
            ("2026-01-01T10Z", None),
            ("275760-09-13T00:00:00Z", None),
            ("+275760-09-13T00:00:00.000Z", Some(8640000000000000)),
            ("+275760-09-13T00:00:00.001Z", None),
        ];
        for (text, expected) in utc {
            assert_eq!(date_parse(text), expected, "{text}");
        }
    }

    #[test]
    fn iso_strings_match_to_iso_string() {
        assert_eq!(to_iso_string(1767261600123), "2026-01-01T10:00:00.123Z");
        assert_eq!(to_iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(to_iso_string(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            to_iso_string(8640000000000000),
            "+275760-09-13T00:00:00.000Z"
        );
        assert_eq!(
            to_iso_string(-62198755200000),
            "-000001-01-01T00:00:00.000Z"
        );
    }
}
