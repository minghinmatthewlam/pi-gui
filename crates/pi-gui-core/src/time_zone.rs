//! Time zones as `Intl.DateTimeFormat` reads them. Zone data comes from the copy of the IANA
//! database bundled into jiff, so the answers do not depend on the computer's copy.

use jiff::tz::{Offset, TimeZone};

/// The zone `Intl.DateTimeFormat` uses for `name`, or `None` where it throws a `RangeError`:
/// an IANA name or link in any letter case, one of the older ids ICU still knows, or a fixed
/// offset such as `+05:30`.
pub fn get(name: &str) -> Option<TimeZone> {
    if let Some(offset) = offset_zone(name) {
        return Some(TimeZone::fixed(offset));
    }
    if let Some((_, zone)) = ICU_ONLY_ZONES
        .iter()
        .find(|(id, _)| id.eq_ignore_ascii_case(name))
    {
        return match zone {
            IcuZone::Link(target) => TimeZone::get(target).ok(),
            IcuZone::Rule(rule) => TimeZone::posix(rule).ok(),
        };
    }
    // jiff's database also lists `Factory` and reads `Etc/Unknown` as a zone; Intl refuses both.
    if ["Factory", "Etc/Unknown"]
        .iter()
        .any(|refused| refused.eq_ignore_ascii_case(name))
    {
        return None;
    }
    TimeZone::get(name).ok()
}

/// Whether `Intl.DateTimeFormat` accepts `name` as a time zone.
pub fn is_time_zone(name: &str) -> bool {
    get(name).is_some()
}

/// The computer's zone (from `TZ` or the system setting).
pub fn host() -> TimeZone {
    TimeZone::system()
}

/// `hostTimeZone()`: the computer's zone name, else UTC, spelled the way Intl reports it: ICU
/// still prefers some older names (`Asia/Calcutta` for `Asia/Kolkata`). A system zone set
/// through an alias such as `US/Eastern` keeps that name.
pub fn host_time_zone() -> String {
    let zone = TimeZone::try_system()
        .ok()
        .and_then(|zone| zone.iana_name().map(str::to_owned))
        .filter(|zone| is_time_zone(zone))
        .unwrap_or_else(|| "UTC".into());
    ICU_PREFERRED_NAMES
        .iter()
        .find(|(name, _)| *name == zone)
        .map_or(zone, |(_, preferred)| (*preferred).to_owned())
}

/// `+05`, `+0530`, `+05:30` or `−05:30` (with a minus sign), up to 23:59 either way.
fn offset_zone(name: &str) -> Option<Offset> {
    let (negative, rest) = if let Some(rest) = name.strip_prefix('+') {
        (false, rest)
    } else {
        let rest = name
            .strip_prefix('-')
            .or_else(|| name.strip_prefix('\u{2212}'))?;
        (true, rest)
    };
    let digits = rest.as_bytes();
    let two = |at: usize, max: i32| {
        let pair = digits.get(at..at + 2)?;
        let value = std::str::from_utf8(pair).ok()?.parse::<i32>().ok()?;
        (pair.iter().all(u8::is_ascii_digit) && value <= max).then_some(value)
    };
    let (hours, minutes) = match digits.len() {
        2 => (two(0, 23)?, 0),
        4 => (two(0, 23)?, two(2, 59)?),
        5 if digits[2] == b':' => (two(0, 23)?, two(3, 59)?),
        _ => return None,
    };
    let seconds = (hours * 60 + minutes) * 60;
    Offset::from_seconds(if negative { -seconds } else { seconds }).ok()
}

enum IcuZone {
    /// The same zone under its IANA name.
    Link(&'static str),
    /// A zone of its own in ICU, as a POSIX TZ rule.
    Rule(&'static str),
}

/// Ids ICU (and so V8) accepts that the IANA database no longer lists, and what they mean.
/// The `SystemV` zones with daylight time keep the US rules from before 2007.
const ICU_ONLY_ZONES: [(&str, IcuZone); 40] = [
    ("ACT", IcuZone::Link("Australia/Darwin")),
    ("AET", IcuZone::Link("Australia/Sydney")),
    ("AGT", IcuZone::Link("America/Buenos_Aires")),
    ("ART", IcuZone::Link("Africa/Cairo")),
    ("AST", IcuZone::Link("America/Anchorage")),
    ("BET", IcuZone::Link("America/Sao_Paulo")),
    ("BST", IcuZone::Link("Asia/Dhaka")),
    ("CAT", IcuZone::Link("Africa/Maputo")),
    ("CNT", IcuZone::Link("America/St_Johns")),
    ("CST", IcuZone::Link("America/Chicago")),
    ("CTT", IcuZone::Link("Asia/Shanghai")),
    ("EAT", IcuZone::Link("Africa/Nairobi")),
    ("ECT", IcuZone::Link("Europe/Paris")),
    ("IET", IcuZone::Link("America/Indianapolis")),
    ("IST", IcuZone::Link("Asia/Calcutta")),
    ("JST", IcuZone::Link("Asia/Tokyo")),
    ("MIT", IcuZone::Link("Pacific/Apia")),
    ("NET", IcuZone::Link("Asia/Yerevan")),
    ("NST", IcuZone::Link("Pacific/Auckland")),
    ("PLT", IcuZone::Link("Asia/Karachi")),
    ("PNT", IcuZone::Link("America/Phoenix")),
    ("PRT", IcuZone::Link("America/Puerto_Rico")),
    ("PST", IcuZone::Link("America/Los_Angeles")),
    ("SST", IcuZone::Link("Pacific/Guadalcanal")),
    ("VST", IcuZone::Link("Asia/Saigon")),
    ("SystemV/AST4", IcuZone::Rule("AST4")),
    ("SystemV/AST4ADT", IcuZone::Rule("AST4ADT,M4.5.0,M10.5.0")),
    ("SystemV/CST6", IcuZone::Rule("CST6")),
    ("SystemV/CST6CDT", IcuZone::Rule("CST6CDT,M4.5.0,M10.5.0")),
    ("SystemV/EST5", IcuZone::Rule("EST5")),
    ("SystemV/EST5EDT", IcuZone::Rule("EST5EDT,M4.5.0,M10.5.0")),
    ("SystemV/HST10", IcuZone::Rule("HST10")),
    ("SystemV/MST7", IcuZone::Rule("MST7")),
    ("SystemV/MST7MDT", IcuZone::Rule("MST7MDT,M4.5.0,M10.5.0")),
    ("SystemV/PST8", IcuZone::Rule("PST8")),
    ("SystemV/PST8PDT", IcuZone::Rule("PST8PDT,M4.5.0,M10.5.0")),
    ("SystemV/YST9", IcuZone::Rule("YST9")),
    ("SystemV/YST9YDT", IcuZone::Rule("YST9YDT,M4.5.0,M10.5.0")),
    ("Canada/East-Saskatchewan", IcuZone::Link("America/Regina")),
    ("US/Pacific-New", IcuZone::Link("America/Los_Angeles")),
];

/// IANA zones whose name ICU reports differently.
const ICU_PREFERRED_NAMES: [(&str, &str); 36] = [
    ("Africa/Asmara", "Africa/Asmera"),
    ("America/Argentina/Buenos_Aires", "America/Buenos_Aires"),
    ("America/Argentina/Catamarca", "America/Catamarca"),
    ("America/Argentina/Cordoba", "America/Cordoba"),
    ("America/Argentina/Jujuy", "America/Jujuy"),
    ("America/Argentina/Mendoza", "America/Mendoza"),
    ("America/Atikokan", "America/Coral_Harbour"),
    ("America/Indiana/Indianapolis", "America/Indianapolis"),
    ("America/Kentucky/Louisville", "America/Louisville"),
    ("America/Nuuk", "America/Godthab"),
    ("Asia/Ho_Chi_Minh", "Asia/Saigon"),
    ("Asia/Kathmandu", "Asia/Katmandu"),
    ("Asia/Kolkata", "Asia/Calcutta"),
    ("Asia/Yangon", "Asia/Rangoon"),
    ("Atlantic/Faroe", "Atlantic/Faeroe"),
    ("CET", "Europe/Brussels"),
    ("CST6CDT", "America/Chicago"),
    ("EET", "Europe/Athens"),
    ("EST", "America/Panama"),
    ("EST5EDT", "America/New_York"),
    ("Etc/GMT", "UTC"),
    ("Etc/Greenwich", "UTC"),
    ("Etc/UCT", "UTC"),
    ("Etc/UTC", "UTC"),
    ("Etc/Universal", "UTC"),
    ("Etc/Zulu", "UTC"),
    ("Europe/Kyiv", "Europe/Kiev"),
    ("HST", "Pacific/Honolulu"),
    ("MET", "Europe/Brussels"),
    ("MST", "America/Phoenix"),
    ("MST7MDT", "America/Denver"),
    ("PST8PDT", "America/Los_Angeles"),
    ("Pacific/Chuuk", "Pacific/Truk"),
    ("Pacific/Kanton", "Pacific/Enderbury"),
    ("Pacific/Pohnpei", "Pacific/Ponape"),
    ("WET", "Europe/Lisbon"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_time_zones_intl_does() {
        for zone in [
            "UTC",
            "utc",
            "Etc/GMT+5",
            "US/Eastern",
            "america/new_york",
            "Asia/Calcutta",
            "PST",
            "SystemV/EST5EDT",
            "+05:30",
            "\u{2212}05",
        ] {
            assert!(is_time_zone(zone), "{zone}");
        }
        for zone in [
            "Not/A_Zone",
            "GMT+5",
            "Etc/GMT+13",
            "+24:00",
            "+5:00",
            "+05:",
            "",
            "Factory",
            "Etc/Unknown",
        ] {
            assert!(!is_time_zone(zone), "{zone}");
        }
    }

    #[test]
    fn zones_keep_intl_offsets() {
        // node -e 'new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })'
        // at 2026-01-01 and 2026-07-01.
        let offset_hours = |name: &str, ms: i64| {
            let zone = get(name).expect("a known zone");
            let timestamp = jiff::Timestamp::from_millisecond(ms).expect("in range");
            zone.to_offset(timestamp).seconds() as f64 / 3600.0
        };
        let (winter, summer) = (1_767_225_600_000, 1_782_864_000_000);
        for (name, expected) in [
            ("IST", (5.5, 5.5)),
            ("PST", (-8.0, -7.0)),
            ("SystemV/EST5EDT", (-5.0, -4.0)),
            ("SystemV/PST8", (-8.0, -8.0)),
            ("-23:59", (-23.0 - 59.0 / 60.0, -23.0 - 59.0 / 60.0)),
            ("+0530", (5.5, 5.5)),
        ] {
            assert_eq!(
                (offset_hours(name, winter), offset_hours(name, summer)),
                expected,
                "{name}"
            );
        }
        // ICU's SystemV daylight time starts on April's last Sunday (2026-04-26).
        let april_20 = 1_776_643_200_000;
        assert_eq!(offset_hours("SystemV/EST5EDT", april_20), -5.0);
        assert_eq!(offset_hours("America/New_York", april_20), -4.0);
    }
}
