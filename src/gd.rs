//! Geometry Dash level lookup via the Boomlings API.

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

// Base game song tracks, indexed by key 11 in the level data.
const OFFICIAL_SONGS: &[&str] = &[
    "Stereo Madness", "Back on Track", "Polargeist", "Dry Out", "Base After Base",
    "Cant Let Go", "Jumper", "Time Machine", "Cycles", "xStep", "Clutterfunk",
    "Theory of Everything", "Electroman Adventures", "Clubstep", "Electrodynamix",
    "Hexagon Force", "Blast Processing", "Theory of Everything 2",
    "Geometrical Dominator", "Deadlocked", "Fingerdash", "Dash",
];

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// Parsed level info returned by [`search_level`].
pub struct LevelInfo {
    pub id: u64,
    pub name: String,
    pub description: String,
    pub creator_username: String,
    pub difficulty: String,
    pub stars: u32,
    pub downloads: u64,
    pub likes: i64,
    pub length: String,
    pub song_name: String,
    pub song_artist: String,
    pub song_id: u32,
}

/// Fetches level info by ID from the Boomlings API. Returns `None` if the level doesn't exist.
///
/// The API signals "not found" with the literal body `"-1"` rather than a 4xx status.
/// The `secret` field is a fixed token hardcoded into every GD client.
pub async fn search_level(id: &str) -> Result<Option<LevelInfo>> {
    let body = HTTP
        .post("https://www.boomlings.com/database/getGJLevels21.php")
        .header("User-Agent", "")
        .form(&[("secret", "Wmfd2893gb7"), ("type", "0"), ("str", id), ("count", "1")])
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    if body.trim() == "-1" {
        return Ok(None);
    }

    let sections: Vec<&str> = body.split('#').collect();
    let kv = parse_kv(sections.first().copied().unwrap_or(""));

    // A missing level ID key means the response isn't valid level data (e.g. an error page).
    if !kv.contains_key("1") {
        anyhow::bail!("unexpected response from Boomlings API");
    }

    // Section 1 maps playerID → username. Key 6 in the level data holds the creator's playerID,
    // not their accountID — the two are different and only playerID appears in this response.
    let creators = parse_creators(sections.get(1).copied().unwrap_or(""));
    let creator_username = kv
        .get("6")
        .and_then(|pid| creators.get(*pid).copied())
        .unwrap_or("-")
        .to_owned();

    let (song_name, song_artist, song_id) = resolve_song(&kv, sections.get(2).copied());

    Ok(Some(LevelInfo {
        id:               kv.get("1").and_then(|s| s.parse().ok()).unwrap_or(0),
        name:             kv.get("2").copied().unwrap_or("").to_owned(),
        description:      decode_description(kv.get("3").copied()),
        creator_username,
        difficulty:       resolve_difficulty(&kv),
        stars:            kv.get("18").and_then(|s| s.parse().ok()).unwrap_or(0),
        downloads:        kv.get("10").and_then(|s| s.parse().ok()).unwrap_or(0),
        likes:            kv.get("14").and_then(|s| s.parse().ok()).unwrap_or(0),
        length:           resolve_length(&kv),
        song_name,
        song_artist,
        song_id,
    }))
}

// Section 0 is a flat stride-2 key:value:key:value:... sequence. Free-text values like
// descriptions are base64url-encoded by the server specifically to prevent raw colons from
// breaking this format, so `:` will never appear unescaped in any value we care about.
// Duplicate keys are not expected; if they occur, HashMap collect silently keeps the last value.
fn parse_kv(section: &str) -> HashMap<&str, &str> {
    section
        .split(':')
        .collect::<Vec<_>>()
        .chunks(2)
        .filter_map(|pair| (pair.len() == 2).then_some((pair[0], pair[1])))
        .collect()
}

// Section 1 entries are `playerID:username:accountID`. We only need the first two fields;
// splitn(3) avoids splitting on a colon that might appear inside an accountID-adjacent value.
fn parse_creators(section: &str) -> HashMap<&str, &str> {
    section
        .split('|')
        .filter(|e| !e.is_empty())
        .filter_map(|entry| {
            let mut parts = entry.splitn(3, ':');
            Some((parts.next()?, parts.next()?))
        })
        .collect()
}

// Descriptions are URL-safe base64 with no padding. The encoding exists solely to keep
// colons out of the value — the stride-2 parser would misalign if they appeared raw.
fn decode_description(raw: Option<&str>) -> String {
    raw.and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

// Difficulty spans three keys: key 17 (is demon), key 25 (is auto), and key 9 (the
// denominator: 10/20/30/40/50 for Easy–Insane). For demons, key 43 gives the sub-type —
// Hard Demon is the implicit default and has no dedicated value, hence the catch-all arm.
fn resolve_difficulty(kv: &HashMap<&str, &str>) -> String {
    if kv.get("17").copied() == Some("1") {
        return match kv.get("43").copied() {
            Some("3") => "Easy Demon",
            Some("4") => "Medium Demon",
            Some("5") => "Insane Demon",
            Some("6") => "Extreme Demon",
            _         => "Hard Demon",
        }
        .to_owned();
    }
    if kv.get("25").copied() == Some("1") {
        return "Auto".to_owned();
    }
    match kv.get("9").copied() {
        Some("10") => "Easy",
        Some("20") => "Normal",
        Some("30") => "Hard",
        Some("40") => "Harder",
        Some("50") => "Insane",
        _          => "N/A",
    }
    .to_owned()
}

// Length is key 15.
fn resolve_length(kv: &HashMap<&str, &str>) -> String {
    match kv.get("15").copied() {
        Some("0") => "Tiny",
        Some("1") => "Short",
        Some("2") => "Medium",
        Some("3") => "Long",
        Some("4") => "XL",
        Some("5") => "Platformer",
        _         => "Unknown",
    }
    .to_owned()
}

// Key 35 holds the Newgrounds song ID. Absent or "0" both mean "use the official soundtrack".
//
// The song section (section 2) uses `~|~` as its delimiter, unlike the `:` used everywhere
// else. It's the same stride-2 key-value structure, just a different separator.
fn resolve_song(kv: &HashMap<&str, &str>, song_section: Option<&str>) -> (String, String, u32) {
    let Some(target_id) = kv.get("35").copied().filter(|&id| id != "0") else {
        let idx = kv
            .get("11")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or_else(|| {
                tracing::warn!("official song key (11) missing or non-numeric; defaulting to 0");
                0
            });
        if idx >= OFFICIAL_SONGS.len() {
            tracing::warn!(song_index = idx, "official song index out of range");
        }
        let name = OFFICIAL_SONGS.get(idx).copied().unwrap_or("Unknown");
        return (name.to_owned(), "RobTop".to_owned(), idx as u32);
    };

    let Some(section) = song_section else {
        tracing::warn!(song_id = target_id, "custom song ID present but song section missing");
        return ("Unknown".to_owned(), "Unknown".to_owned(), target_id.parse().unwrap_or(0));
    };

    let song_kv: HashMap<&str, &str> = section
        .split("~|~")
        .collect::<Vec<_>>()
        .chunks(2)
        .filter_map(|pair| (pair.len() == 2).then_some((pair[0], pair[1])))
        .collect();

    if song_kv.get("1").copied() == Some(target_id) {
        return (
            song_kv.get("2").copied().unwrap_or("Unknown").to_owned(),
            song_kv.get("4").copied().unwrap_or("Unknown").to_owned(),
            target_id.parse().unwrap_or(0),
        );
    }

    tracing::warn!(song_id = target_id, "custom song not found in song section");
    ("Unknown".to_owned(), "Unknown".to_owned(), target_id.parse().unwrap_or(0))
}
