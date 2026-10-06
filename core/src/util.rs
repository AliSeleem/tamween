//! Ports of src/shared/util.ts used by the backend. The UI keeps its own TypeScript copy.

pub fn is_month(m: &str) -> bool {
    let b = m.as_bytes();
    if b.len() != 7 || b[4] != b'-' || !b[..4].iter().chain(&b[5..]).all(u8::is_ascii_digit) {
        return false;
    }
    matches!(&m[5..], "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12")
}

pub fn add_months(month: &str, delta: i64) -> String {
    let y: i64 = month[..4].parse().unwrap_or(0);
    let m: i64 = month[5..7].parse().unwrap_or(1);
    let idx = y * 12 + (m - 1) + delta;
    format!("{}-{:02}", idx.div_euclid(12), idx.rem_euclid(12) + 1)
}

const AR_MONTHS: [&str; 12] = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

pub fn month_label(month: &str) -> String {
    if !is_month(month) {
        return month.to_string();
    }
    let m: usize = month[5..7].parse().unwrap_or(1);
    format!("{} {}", AR_MONTHS[m - 1], &month[..4])
}

/// 985000 -> "9,850.00"
pub fn format_money(piasters: i64) -> String {
    let sign = if piasters < 0 { "-" } else { "" };
    let abs = piasters.unsigned_abs();
    let pounds = (abs / 100).to_string();
    let mut grouped = String::new();
    for (i, ch) in pounds.chars().enumerate() {
        if i > 0 && (pounds.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    format!("{sign}{grouped}.{:02}", abs % 100)
}

/// Arabic-Indic and Persian digits to ASCII, Arabic decimal separator to '.'.
pub fn normalize_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{0660}'..='\u{0669}' => char::from(b'0' + (c as u32 - 0x0660) as u8),
            '\u{06F0}'..='\u{06F9}' => char::from(b'0' + (c as u32 - 0x06F0) as u8),
            '\u{066B}' => '.',
            _ => c,
        })
        .collect()
}

/// Collapses runs of whitespace into one space and trims.
pub fn squash_spaces(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Folds spelling variants (أ/إ/آ, ى/ي, ة/ه, diacritics, extra spaces) so the same Arabic name or header matches.
pub fn arabic_key(text: &str) -> String {
    let folded: String = normalize_digits(text)
        .chars()
        .filter(|c| !matches!(c, '\u{064B}'..='\u{0652}' | '\u{0640}'))
        .map(|c| match c {
            'أ' | 'إ' | 'آ' => 'ا',
            'ى' => 'ي',
            'ة' => 'ه',
            _ => c,
        })
        .collect();
    squash_spaces(&folded).to_lowercase()
}

/// Keeps a code such as a batch number in left-to-right order inside Arabic text.
pub fn ltr(text: &str) -> String {
    format!("\u{2066}{text}\u{2069}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months() {
        assert!(is_month("2026-10"));
        assert!(!is_month("2026-13"));
        assert!(!is_month("2026-1"));
        assert_eq!(add_months("2026-12", 1), "2027-01");
        assert_eq!(add_months("2026-01", -1), "2025-12");
        assert_eq!(month_label("2026-10"), "أكتوبر 2026");
    }

    #[test]
    fn text() {
        assert_eq!(format_money(-471000012), "-4,710,000.12");
        assert_eq!(format_money(5), "0.05");
        assert_eq!(normalize_digits("١٠٠١"), "1001");
        assert_eq!(arabic_key("  فتحى  رشدى أحمد "), "فتحي رشدي احمد");
        assert_eq!(arabic_key("عدد الأفراد"), arabic_key("عدد الافراد"));
    }
}
