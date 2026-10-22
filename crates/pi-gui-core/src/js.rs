//! JavaScript behaviour the saved files and the state code depend on, so the Rust twins give
//! the same strings: `String(number)` and how `JSON.stringify` writes numbers and indents, the
//! order `Object.keys` lists keys in, `\s` and `String.prototype.trim`, string length, slices
//! and order in UTF-16 units, `encodeURIComponent`, `Math.round`, and the ISO subset of
//! `Date.parse` and `toISOString`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::cmp::Ordering;

/// A JavaScript number passed through the app. It serializes whole numbers as integers
/// (`3`, not `3.0`) so values compare equal to the ones parsed from JavaScript's JSON, and
/// non-finite ones as `null`. Write the result with [`stringify`] for JavaScript's text
/// (`1e+21`; serde_json alone writes `1e21`).
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default)]
pub struct JsNumber(pub f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            // -0 stringifies as 0 in JavaScript.
            serializer.serialize_i64(value as i64)
        } else {
            serializer.serialize_f64(value)
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(JsNumber)
    }
}

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
        Value::Number(number) => match number.as_f64().filter(|number| number.is_finite()) {
            Some(number) => out.push_str(&number_to_string(number)),
            None => out.push_str("null"),
        },
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

/// `String(value)` for a number (ECMAScript Number::toString with radix 10): `1e+21`,
/// `5e-7`, `0` for `-0`, no `.0` on whole numbers.
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value < 0.0 {
        return format!("-{}", number_to_string(-value));
    }
    // `{:e}` gives the shortest digits that round-trip, as JavaScript does.
    let exponential = format!("{value:e}");
    let (mantissa, exponent) = exponential.split_once('e').unwrap_or((&exponential, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
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

/// The characters JavaScript's `\s` and `String.prototype.trim` treat as white space, which
/// differ from Rust's (JavaScript has U+FEFF but not U+0085).
pub fn is_space(c: char) -> bool {
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

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.replace(/\s+/g, " ")`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A string's `length` in JavaScript: UTF-16 code units.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, end)` in UTF-16 code units. A cut through a surrogate pair leaves half a
/// character in JavaScript; Rust strings cannot hold that, so it becomes `�`.
pub fn utf16_prefix(text: &str, end: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        let width = c.len_utf16();
        if units + width > end {
            if units < end {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        units += width;
    }
    out
}

/// `left < right` style comparison of JavaScript strings, which compares UTF-16 code units.
pub fn compare_strings(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `Math.round`: halves round up, toward +∞.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Math.max(a, b)`: NaN wins.
pub fn max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
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

const MS_PER_DAY: f64 = 86_400_000.0;
/// The largest time a JavaScript Date holds, in milliseconds either side of 1970.
const MAX_TIME_MS: f64 = 8.64e15;

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). Like
/// `Date.UTC`, a month or day past its range rolls over into the next year or month.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year + (month - 1).div_euclid(12);
    let month = (month - 1).rem_euclid(12) + 1;
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (day - 1)
}

/// (year, month 1-12, day 1-31) for days since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `Date.UTC(year, month - 1, day, hour, minute)` for whole numbers.
pub fn date_utc(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> f64 {
    (days_from_civil(year, month, day) as f64) * MS_PER_DAY
        + (hour as f64) * 3_600_000.0
        + (minute as f64) * 60_000.0
}

/// `new Date(ms).toISOString()`, or `None` where JavaScript throws "Invalid time value".
pub fn to_iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > MAX_TIME_MS {
        return None;
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

/// `Date.parse(text)` for the ISO forms V8 reads: `YYYY[-MM[-DD]]` (or `±YYYYYY`), then
/// optionally `T` and `HH:mm[:ss[.fff]]`, then `Z`, `±HH:mm`, `±HHmm` or nothing. A space
/// in place of the `T` reads the same, as V8's fallback parser gives for that shape. Like
/// V8, a day past the month's end rolls over, a date alone is UTC and a time with no offset
/// is local time in `local`. V8 also reads many legacy forms ("Jan 2 2026"); those give
/// `None` (NaN) here.
pub fn date_parse(text: &str, local: &jiff::tz::TimeZone) -> Option<f64> {
    let mut parser = IsoParser {
        bytes: text.as_bytes(),
        at: 0,
    };
    let year = parser.year()?;
    let mut month = 1;
    let mut day = 1;
    if parser.eat(b'-') {
        month = parser.digits(2)?;
        if parser.eat(b'-') {
            day = parser.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if parser.done() {
        let ms = date_utc(year, month, day, 0, 0);
        return (ms.abs() <= MAX_TIME_MS).then_some(ms);
    }
    if !(parser.eat(b'T') || parser.eat(b't') || parser.eat(b' ')) {
        return None;
    }
    let hour = parser.digits(2)?;
    if !parser.eat(b':') {
        return None;
    }
    let minute = parser.digits(2)?;
    let mut second = 0;
    let mut millisecond = 0;
    if parser.eat(b':') {
        second = parser.digits(2)?;
        if parser.eat(b'.') {
            let start = parser.at;
            while parser.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                parser.at += 1;
            }
            let fraction = &text[start..parser.at];
            if fraction.is_empty() {
                return None;
            }
            let padded = format!("{fraction:0<3}");
            millisecond = padded[..3].parse::<i64>().ok()?;
        }
    }
    let valid_time = (hour < 24 && minute < 60 && second < 60)
        || (hour == 24 && minute == 0 && second == 0 && millisecond == 0);
    if !valid_time {
        return None;
    }
    let wall = date_utc(year, month, day, hour, minute) + (second * 1000 + millisecond) as f64;
    let offset_ms = if parser.eat(b'Z') || parser.eat(b'z') {
        Some(0.0)
    } else if let Some(sign) = parser.peek().filter(|byte| *byte == b'+' || *byte == b'-') {
        parser.at += 1;
        let hours = parser.digits(2)?;
        parser.eat(b':');
        let minutes = parser.digits(2)?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        let offset = (hours * 60 + minutes) as f64 * 60_000.0;
        Some(if sign == b'+' { offset } else { -offset })
    } else {
        None
    };
    if !parser.done() {
        return None;
    }
    let ms = match offset_ms {
        Some(offset) => wall - offset,
        None => local_wall_time_ms(wall, local)?,
    };
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

/// The instant a wall-clock time in `local` (written as if it were UTC) names. A skipped
/// time moves forward by the gap and a repeated one takes the earlier instant, as V8 does.
fn local_wall_time_ms(wall_as_utc_ms: f64, local: &jiff::tz::TimeZone) -> Option<f64> {
    let wall = jiff::Timestamp::from_millisecond(wall_as_utc_ms as i64)
        .ok()?
        .to_zoned(jiff::tz::TimeZone::UTC)
        .datetime();
    let zoned = local.to_ambiguous_zoned(wall).compatible().ok()?;
    Some(zoned.timestamp().as_millisecond() as f64)
}

struct IsoParser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl IsoParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn done(&self) -> bool {
        self.at == self.bytes.len()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self, count: usize) -> Option<i64> {
        let slice = self.bytes.get(self.at..self.at + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        std::str::from_utf8(slice).ok()?.parse().ok()
    }

    fn year(&mut self) -> Option<i64> {
        match self.peek() {
            Some(b'+') => {
                self.at += 1;
                self.digits(6)
            }
            Some(b'-') => {
                self.at += 1;
                let year = self.digits(6)?;
                // "-000000" is not a year.
                (year != 0).then_some(-year)
            }
            _ => self.digits(4),
        }
    }
}

/// `new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })` in the
/// en-US format ("7:05 PM") in `zone`. Other locales are not mirrored.
pub fn en_us_time_of_day(ms: f64, zone: &jiff::tz::TimeZone) -> String {
    let Some(zoned) = jiff::Timestamp::from_millisecond(ms as i64)
        .ok()
        .filter(|_| ms.is_finite())
        .map(|timestamp| timestamp.to_zoned(zone.clone()))
    else {
        return "Invalid Date".into();
    };
    let hour = zoned.hour();
    let (hour12, period) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{hour12}:{:02} {period}", zoned.minute())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        // node -e 'console.log(JSON.stringify([0, -0, 3, 1.5, 1e21, ...]))'
        let cases = [
            (json!(0), "0"),
            (json!(-0.0), "0"),
            (json!(3.0), "3"),
            (json!(1.5), "1.5"),
            (json!(0.1 + 0.2), "0.30000000000000004"),
            (json!(1e21), "1e+21"),
            (json!(1e20), "100000000000000000000"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(5e-7), "5e-7"),
            (json!(123e-20), "1.23e-18"),
            (json!(0.000001), "0.000001"),
            (json!(-1.25e-10), "-1.25e-10"),
            (json!(1.7976931348623157e308), "1.7976931348623157e+308"),
            (json!(12345678901234567890u64), "12345678901234567000"),
            (json!(9007199254740994u64), "9007199254740994"),
            (json!(-42), "-42"),
        ];
        for (value, expected) in cases {
            assert_eq!(stringify(&value), expected, "{value}");
        }
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(number_to_string(f64::NEG_INFINITY), "-Infinity");
        let numbers = serde_json::to_value([JsNumber(1e21), JsNumber(3.0), JsNumber(-0.0)])
            .expect("numbers encode");
        assert_eq!(numbers, json!([1e21, 3, 0]));
        assert_eq!(stringify(&numbers), "[1e+21,3,0]");
    }

    #[test]
    fn output_matches_json_stringify() {
        let value = json!({ "b": [1, { "x": [] }], "a": {}, "2": "two", "1": null });
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"1\": null,\n  \"2\": \"two\",\n  \"b\": [\n    1,\n    {\n      \"x\": []\n    }\n  ],\n  \"a\": {}\n}"
        );
        assert_eq!(
            stringify(&json!(["a\u{1}\n", "é"])),
            "[\"a\\u0001\\n\",\"é\"]"
        );
        let value: Value = serde_json::from_str(r#"{"b":1.0,"2":[true,null],"a":"x\n","1":1e21}"#)
            .expect("valid JSON");
        assert_eq!(
            stringify(&value),
            r#"{"1":1e+21,"2":[true,null],"b":1,"a":"x\n"}"#
        );
    }

    #[test]
    fn trims_and_collapses_javascript_white_space() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
        assert_eq!(collapse_whitespace("a \t\n b\u{a0}c"), "a b c");
    }

    #[test]
    fn utf16_prefix_replaces_a_split_surrogate_pair() {
        assert_eq!(length("a😀"), 3);
        assert_eq!(utf16_prefix("a😀b", 2), "a\u{FFFD}");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
    }

    #[test]
    fn rounds_halves_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
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
    fn months_roll_over_like_date_utc() {
        // node -e 'console.log(Date.UTC(2026, 13, 1), Date.UTC(2026, -1, 1))'
        assert_eq!(date_utc(2026, 14, 1, 0, 0), 1_801_440_000_000.0);
        assert_eq!(date_utc(2026, 0, 1, 0, 0), 1_764_547_200_000.0);
    }

    #[test]
    fn parses_iso_dates_like_v8() {
        // TZ=UTC node -e 'console.log(Date.parse(text))' for each text.
        let utc = jiff::tz::TimeZone::UTC;
        let cases = [
            ("2026-02-31T00:00:00Z", Some(1772496000000.0)),
            ("2026-01-01", Some(1767225600000.0)),
            ("2026-01", Some(1767225600000.0)),
            ("2026", Some(1767225600000.0)),
            ("+002026-01-01T00:00:00Z", Some(1767225600000.0)),
            ("2026-01-01T24:00:00Z", Some(1767312000000.0)),
            ("2026-01-01T24:00:01Z", None),
            ("2026-01-01T10:00Z", Some(1767261600000.0)),
            ("2026-01-01T10:00:00.1234Z", Some(1767261600123.0)),
            ("2026-01-01T10:00:00.1Z", Some(1767261600100.0)),
            ("2026-01-01t10:00:00z", Some(1767261600000.0)),
            ("2026-01-01T10:00:00+0530", Some(1767241800000.0)),
            ("2026-01-01T10:00:00+05:30", Some(1767241800000.0)),
            ("2026-10-01T19:00:00", Some(1790881200000.0)),
            ("2026-10-04 12:00", Some(1791115200000.0)),
            ("2026-10-01 19:00:00Z", Some(1790881200000.0)),
            ("2026-10-01T19:00:00,5Z", None),
            ("-000000-01-01T00:00:00Z", None),
            ("2026-13-01", None),
            ("2026-01-01T10:00:00.Z", None),
            ("2026-01-01T10Z", None),
            ("275760-09-13T00:00:00Z", None),
            ("+275760-09-13T00:00:00.000Z", Some(8640000000000000.0)),
            ("+275760-09-13T00:00:00.001Z", None),
            ("not a date", None),
            ("", None),
        ];
        for (text, expected) in cases {
            assert_eq!(date_parse(text, &utc), expected, "{text}");
        }
    }

    #[test]
    fn local_times_resolve_like_v8() {
        // TZ=America/New_York node -e 'console.log(Date.parse(text))': a skipped time moves
        // forward, a repeated one takes the earlier instant.
        let new_york = jiff::tz::TimeZone::get("America/New_York").expect("a known zone");
        assert_eq!(
            date_parse("2026-03-08T02:30", &new_york),
            Some(1772955000000.0)
        );
        assert_eq!(
            date_parse("2026-11-01T01:30", &new_york),
            Some(1793511000000.0)
        );
    }

    #[test]
    fn iso_strings_match_to_iso_string() {
        assert_eq!(
            to_iso_string(1767261600123.0).as_deref(),
            Some("2026-01-01T10:00:00.123Z")
        );
        assert_eq!(
            to_iso_string(0.0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(-1.0).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            to_iso_string(8640000000000000.0).as_deref(),
            Some("+275760-09-13T00:00:00.000Z")
        );
        assert_eq!(
            to_iso_string(-62198755200000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(to_iso_string(f64::NAN), None);
    }

    #[test]
    fn formats_time_of_day_in_en_us() {
        let utc = jiff::tz::TimeZone::UTC;
        assert_eq!(en_us_time_of_day(1_790_881_500_000.0, &utc), "7:05 PM");
        assert_eq!(en_us_time_of_day(1_790_812_800_000.0, &utc), "12:00 AM");
        assert_eq!(en_us_time_of_day(f64::NAN, &utc), "Invalid Date");
    }
}
