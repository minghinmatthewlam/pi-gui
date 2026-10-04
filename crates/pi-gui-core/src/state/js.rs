//! The JavaScript behaviour the state code leans on, so the Rust twins give the same strings:
//! `String(number)`, `JSON.stringify`, `Date.parse`, `toISOString`, `\s` and `trim`, UTF-16
//! lengths and string order, and `Math.round`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::cmp::Ordering;

/// A JavaScript number passed through the app. It serializes like `JSON.stringify`: whole
/// numbers without a fraction (`3`, not `3.0`) and non-finite ones as `null`.
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

/// `String(value)` for a number (ECMAScript Number::toString with radix 10).
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

/// `JSON.stringify(value)` without indentation. Object keys that are array indexes come
/// first in ascending order, as in a JavaScript object; numbers print as JavaScript does.
pub fn json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            if number.is_finite() {
                out.push_str(&number_to_string(number));
            } else {
                out.push_str("null");
            }
        }
        Value::String(text) => out.push_str(&quote(text)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in object_keys_in_js_order(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&quote(key));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// An object's entries in JavaScript's property order: array-index keys ascending, then the
/// rest in insertion order.
pub fn object_keys_in_js_order(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexes: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut others = Vec::new();
    for entry in map.iter() {
        match array_index(entry.0) {
            Some(index) => indexes.push((index, entry)),
            None => others.push(entry),
        }
    }
    indexes.sort_by_key(|(index, _)| *index);
    indexes
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(others)
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

/// The characters JavaScript's `\s` and `String.prototype.trim` treat as white space.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `value.trim()`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// `value.replace(/\s+/g, " ")`.
pub fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if is_js_whitespace(c) {
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

/// `value.length`: UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `value.slice(0, end)` in UTF-16 code units. A cut through a surrogate pair leaves half a
/// character in JavaScript; Rust strings cannot hold that, so it becomes `�`.
pub fn utf16_prefix(value: &str, end: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in value.chars() {
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
pub fn js_string_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `Math.round`: halves round up, toward +∞.
pub fn js_round(value: f64) -> f64 {
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
pub fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

const MS_PER_DAY: f64 = 86_400_000.0;
/// The largest time a JavaScript Date holds, in milliseconds either side of 1970.
const MAX_TIME_MS: f64 = 8.64e15;

/// Days since 1970-01-01 for a proleptic Gregorian date (`month` 1-12, `day` may overflow).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    // Normalize the month so that `Date.UTC(2026, 13, 1)` style overflow works.
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

/// `Date.parse(text)` for the ISO date-time forms the app writes and reads:
/// `YYYY[-MM[-DD]]`, optionally `T` (or a space) and `HH:mm[:ss[.fff]]`, then `Z`, `±HH:mm`,
/// `±HHmm` or nothing. A date alone is UTC; a time with no offset is local time in
/// `local`. V8 also accepts many legacy forms ("Jan 2 2026"); those give `None` (NaN) here.
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
        if parser.eat(b'.') || parser.eat(b',') {
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
        None => wall - local_offset_ms(wall, local)?,
    };
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

/// The offset of `local` for a wall-clock time written as if it were UTC. A skipped time
/// moves forward and a repeated one takes the earlier instant, as JavaScript does.
fn local_offset_ms(wall_as_utc_ms: f64, local: &jiff::tz::TimeZone) -> Option<f64> {
    let wall = jiff::Timestamp::from_millisecond(wall_as_utc_ms as i64)
        .ok()?
        .to_zoned(jiff::tz::TimeZone::UTC)
        .datetime();
    let zoned = local.to_ambiguous_zoned(wall).compatible().ok()?;
    Some(f64::from(zoned.offset().seconds()) * 1000.0)
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

    #[test]
    fn numbers_print_as_javascript_does() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (3.0, "3"),
            (2.5, "2.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123e-20, "1.23e-18"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (-1.5, "-1.5"),
            (f64::NAN, "NaN"),
        ];
        for (value, expected) in cases {
            assert_eq!(number_to_string(value), expected, "{value}");
        }
    }

    #[test]
    fn stringify_orders_index_keys_first_and_prints_numbers_like_javascript() {
        let value: Value = serde_json::from_str(r#"{"b":1.0,"2":[true,null],"a":"x\n","1":1e21}"#)
            .expect("valid JSON");
        assert_eq!(
            json_stringify(&value),
            r#"{"1":1e+21,"2":[true,null],"b":1,"a":"x\n"}"#
        );
    }

    #[test]
    fn trims_and_collapses_javascript_white_space() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{0085}a"), "\u{0085}a");
        assert_eq!(collapse_whitespace("a \t\n b\u{00A0}c"), "a b c");
    }

    #[test]
    fn utf16_prefix_replaces_a_split_surrogate_pair() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("a😀b", 2), "a\u{FFFD}");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
    }

    #[test]
    fn rounds_halves_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }

    #[test]
    fn parses_and_prints_iso_dates() {
        let utc = jiff::tz::TimeZone::UTC;
        let cases = [
            ("2026-10-01T19:00:00.000Z", Some(1_790_881_200_000.0)),
            ("2026-10-01T19:00:00.1234Z", Some(1_790_881_200_123.0)),
            ("2026-10-01T24:00:00Z", Some(1_790_899_200_000.0)),
            ("2026-10-01T19:00Z", Some(1_790_881_200_000.0)),
            ("2026-10-01T19:00:00+0100", Some(1_790_877_600_000.0)),
            ("2026-10-01 19:00:00Z", Some(1_790_881_200_000.0)),
            ("+002026-10-01T19:00:00Z", Some(1_790_881_200_000.0)),
            ("2026-02-30", Some(1_772_409_600_000.0)),
            ("2026", Some(1_767_225_600_000.0)),
            ("2026-10-01T19:00:00", Some(1_790_881_200_000.0)),
            ("not a date", None),
            ("", None),
        ];
        for (text, expected) in cases {
            assert_eq!(date_parse(text, &utc), expected, "{text}");
        }
        assert_eq!(
            to_iso_string(1_790_881_200_123.0).as_deref(),
            Some("2026-10-01T19:00:00.123Z")
        );
        assert_eq!(
            to_iso_string(-1.0).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
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
