//! CLI versions and the ranges detection rules are measured against.
//!
//! Deliberately not semver: agent CLIs do not agree on a version grammar and
//! several of them are not semver at all (`2.1.263`, `1.18.15`, `0.2026.9.1`,
//! `v1.2`). What every one of them *does* publish is a dotted numeric release
//! ordinal, which is all rule selection needs — a comparison, not a
//! compatibility judgement. Anything after the numeric run (`-beta.2`,
//! `+build`) is kept for display and ignored for ordering, because a
//! prerelease of a version is the version as far as its rendered chrome goes.

use std::fmt;

/// A provider CLI release, as probed from the installed binary.
#[derive(Debug, Clone, Eq)]
pub struct CliVersion {
    /// The dotted numeric components, most significant first.
    parts: Vec<u64>,
    /// What the CLI actually printed, for logs and session reporting.
    raw: String,
}

impl CliVersion {
    /// Parse a version out of arbitrary `--version` output.
    ///
    /// CLIs pad their answer differently ("2.1.263 (Claude Code)",
    /// "codex-cli 0.52.0", "opencode 1.18.15"), so this scans for the first
    /// dotted numeric run rather than requiring the whole line to be a
    /// version. A bare integer is not accepted: "Claude Code 2" is far more
    /// likely to be prose than a release.
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if !bytes[index].is_ascii_digit() {
                index += 1;
                continue;
            }
            // A digit preceded by a version-ish character is mid-token
            // ("sha-1a2b3"); only start at a boundary.
            if index > 0 && !matches!(bytes[index - 1], b' ' | b'v' | b'V' | b'(' | b'\t' | b'\n') {
                index += 1;
                continue;
            }
            let start = index;
            let mut parts = Vec::new();
            let mut current: u64 = 0;
            let mut digits = 0usize;
            while index < bytes.len() {
                match bytes[index] {
                    digit if digit.is_ascii_digit() => {
                        current = current
                            .saturating_mul(10)
                            .saturating_add(u64::from(digit - b'0'));
                        digits += 1;
                        index += 1;
                    }
                    b'.' if digits > 0 && bytes.get(index + 1).is_some_and(u8::is_ascii_digit) => {
                        parts.push(current);
                        current = 0;
                        digits = 0;
                        index += 1;
                    }
                    _ => break,
                }
            }
            if digits > 0 {
                parts.push(current);
            }
            if parts.len() >= 2 {
                let raw = text[start..]
                    .split_whitespace()
                    .next()
                    .unwrap_or(&text[start..index])
                    .trim_end_matches([',', ')', ';'])
                    .to_string();
                return Some(Self { parts, raw });
            }
        }
        None
    }

    /// What the CLI printed, verbatim enough to recognise in a log.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    fn component(&self, index: usize) -> u64 {
        self.parts.get(index).copied().unwrap_or(0)
    }
}

impl fmt::Display for CliVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.raw)
    }
}

/// Equality is ordering, not string identity: `2.1` and `2.1.0` are the same
/// release, and a rule range must not treat them differently because one CLI
/// prints a trailing zero and another does not.
impl PartialEq for CliVersion {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl PartialOrd for CliVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for CliVersion {
    /// Missing components compare as zero, so `2.1` precedes `2.1.1` and
    /// equals `2.1.0`.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let width = self.parts.len().max(other.parts.len());
        for index in 0..width {
            let ordering = self.component(index).cmp(&other.component(index));
            if ordering != std::cmp::Ordering::Equal {
                return ordering;
            }
        }
        std::cmp::Ordering::Equal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Comparator {
    GreaterOrEqual,
    Greater,
    LessOrEqual,
    Less,
    Equal,
    NotEqual,
}

impl Comparator {
    fn parse(text: &str) -> Option<(Self, &str)> {
        for (token, comparator) in [
            (">=", Self::GreaterOrEqual),
            ("<=", Self::LessOrEqual),
            ("!=", Self::NotEqual),
            ("==", Self::Equal),
            (">", Self::Greater),
            ("<", Self::Less),
            ("=", Self::Equal),
        ] {
            if let Some(rest) = text.strip_prefix(token) {
                return Some((comparator, rest.trim()));
            }
        }
        None
    }

    fn admits(self, candidate: &CliVersion, bound: &CliVersion) -> bool {
        let ordering = candidate.cmp(bound);
        match self {
            Self::GreaterOrEqual => ordering.is_ge(),
            Self::Greater => ordering.is_gt(),
            Self::LessOrEqual => ordering.is_le(),
            Self::Less => ordering.is_lt(),
            Self::Equal => ordering.is_eq(),
            Self::NotEqual => !ordering.is_eq(),
        }
    }
}

/// The CLI versions a rule or vocabulary entry was measured against.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VersionRange {
    /// Empty means `*`: every version, and every unknown one.
    bounds: Vec<(Comparator, CliVersion)>,
    raw: String,
}

impl VersionRange {
    /// `*`, or a comma-separated conjunction of comparators
    /// (`>=2.1.263`, `>=1.16,<1.19`).
    pub fn parse(text: &str) -> Result<Self, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed == "*" {
            return Ok(Self {
                bounds: Vec::new(),
                raw: "*".to_string(),
            });
        }
        let mut bounds = Vec::new();
        for clause in trimmed.split(',') {
            let clause = clause.trim();
            if clause.is_empty() {
                return Err(format!("empty comparator in version range {text:?}"));
            }
            let (comparator, rest) = Comparator::parse(clause)
                .ok_or_else(|| format!("version range {text:?} has no comparator in {clause:?}"))?;
            let bound = CliVersion::parse(rest).ok_or_else(|| {
                format!("version range {text:?} has an unparseable version in {clause:?}")
            })?;
            bounds.push((comparator, bound));
        }
        Ok(Self {
            bounds,
            raw: trimmed.to_string(),
        })
    }

    /// Whether this entry applies to a session running `version`.
    ///
    /// `None` — the probe has not landed, failed, or the session was inherited
    /// from a daemon that could not report one — admits **every** entry. The
    /// union is what an unknown-version session classified from before version
    /// gating existed, and narrowing it would trade a known gap for a worse
    /// one.
    pub fn admits(&self, version: Option<&CliVersion>) -> bool {
        let Some(version) = version else {
            return true;
        };
        self.bounds
            .iter()
            .all(|(comparator, bound)| comparator.admits(version, bound))
    }

    /// Whether this range constrains anything at all.
    pub fn is_unbounded(&self) -> bool {
        self.bounds.is_empty()
    }

    pub fn as_str(&self) -> &str {
        &self.raw
    }
}

impl fmt::Display for VersionRange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.raw)
    }
}

#[cfg(test)]
mod tests {
    use super::{CliVersion, VersionRange};

    fn version(text: &str) -> CliVersion {
        CliVersion::parse(text).expect("version must parse")
    }

    #[test]
    fn parses_the_version_out_of_real_cli_output() {
        for (output, expected) in [
            ("2.1.263 (Claude Code)", "2.1.263"),
            ("codex-cli 0.52.0", "0.52.0"),
            ("opencode 1.18.15", "1.18.15"),
            ("v1.2.3", "1.2.3"),
            ("GitHub Copilot CLI 0.0.354\n", "0.0.354"),
        ] {
            assert_eq!(version(output).raw(), expected, "for {output:?}");
        }
    }

    #[test]
    fn a_bare_integer_is_not_a_version() {
        assert!(CliVersion::parse("Claude Code 2").is_none());
        assert!(CliVersion::parse("no digits here").is_none());
    }

    #[test]
    fn missing_components_compare_as_zero() {
        assert_eq!(version("2.1"), version("2.1.0"));
        assert!(version("2.1.263") > version("2.1.59"));
        assert!(version("1.18.15") > version("1.16.2"));
    }

    #[test]
    fn ranges_are_conjunctions() {
        let range = VersionRange::parse(">=1.16,<1.19").unwrap();
        assert!(range.admits(Some(&version("1.18.15"))));
        assert!(!range.admits(Some(&version("1.19.0"))));
        assert!(!range.admits(Some(&version("1.15.9"))));
    }

    #[test]
    fn an_unknown_version_admits_every_rule() {
        for text in ["*", ">=2.1.263", "<2.1.263", ">=1.16,<1.19"] {
            assert!(
                VersionRange::parse(text).unwrap().admits(None),
                "{text} must admit an unknown-version session"
            );
        }
    }

    #[test]
    fn a_star_range_admits_every_known_version() {
        let range = VersionRange::parse("*").unwrap();
        assert!(range.is_unbounded());
        assert!(range.admits(Some(&version("0.0.1"))));
        assert!(range.admits(Some(&version("99.0.0"))));
    }

    #[test]
    fn malformed_ranges_are_refused() {
        for text in ["2.1.263", ">=", ">=abc", ">=1.0,,<2.0"] {
            assert!(
                VersionRange::parse(text).is_err(),
                "{text:?} must not parse as a version range"
            );
        }
    }
}
