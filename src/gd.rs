//! Geometry Dash level lookup via the Boomlings API.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

/// Base game song tracks, indexed by key 11 in the level data.
const OFFICIAL_SONGS: &[&str] = &[
    "Stereo Madness",
    "Back on Track",
    "Polargeist",
    "Dry Out",
    "Base After Base",
    "Cant Let Go",
    "Jumper",
    "Time Machine",
    "Cycles",
    "xStep",
    "Clutterfunk",
    "Theory of Everything",
    "Electroman Adventures",
    "Clubstep",
    "Electrodynamix",
    "Hexagon Force",
    "Blast Processing",
    "Theory of Everything 2",
    "Geometrical Dominator",
    "Deadlocked",
    "Fingerdash",
    "Dash",
];

/// Shared HTTP client for all Boomlings API requests; initialized once on first use.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build Boomlings HTTP client")
});

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
pub async fn search_level(id: &str) -> Result<Option<LevelInfo>> {
    let body = HTTP
        .post("https://www.boomlings.com/database/getGJLevels21.php")
        .header("User-Agent", "")
        .form(&[
            ("secret", "Wmfd2893gb7"),
            ("type", "0"),
            ("str", id),
            ("count", "1"),
        ])
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

    let actual_id = kv.get("1").copied().unwrap_or_default();
    if actual_id != id {
        tracing::info!(
            requested_id = id,
            actual_id,
            "Boomlings returned a different level"
        );
        return Ok(None);
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
        id: actual_id.parse().unwrap_or(0),
        name: kv.get("2").copied().unwrap_or("").to_owned(),
        description: decode_description(kv.get("3").copied()),
        creator_username,
        difficulty: resolve_difficulty(&kv),
        stars: kv.get("18").and_then(|s| s.parse().ok()).unwrap_or(0),
        downloads: kv.get("10").and_then(|s| s.parse().ok()).unwrap_or(0),
        likes: kv.get("14").and_then(|s| s.parse().ok()).unwrap_or(0),
        length: resolve_length(&kv),
        song_name,
        song_artist,
        song_id,
    }))
}

/// Parses a flat stride-2 `key:value:key:value:...` section into a map.
fn parse_kv(section: &str) -> HashMap<&str, &str> {
    section
        .split(':')
        .collect::<Vec<_>>()
        .chunks(2)
        .filter_map(|pair| (pair.len() == 2).then_some((pair[0], pair[1])))
        .collect()
}

/// Parses the creators section (`playerID:username:accountID|...`) into a playerID-to-username map.
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

/// Decodes a level description, accepting either URL-safe or standard base64.
fn decode_description(raw: Option<&str>) -> String {
    raw.and_then(|s| {
        URL_SAFE_NO_PAD
            .decode(s)
            .ok()
            .or_else(|| STANDARD.decode(s).ok())
    })
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .map(|text| text.trim().to_owned())
    .filter(|text| !text.is_empty())
    .unwrap_or_default()
}

/// Resolves the human-readable difficulty label from keys 9, 17, 25, and 43 in the level data.
fn resolve_difficulty(kv: &HashMap<&str, &str>) -> String {
    if kv.get("17").copied() == Some("1") {
        return match kv.get("43").copied() {
            Some("3") => "Easy Demon",
            Some("4") => "Medium Demon",
            Some("5") => "Insane Demon",
            Some("6") => "Extreme Demon",
            _ => "Hard Demon",
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
        _ => "N/A",
    }
    .to_owned()
}

/// Maps the numeric length key (key 15) to its human-readable label.
fn resolve_length(kv: &HashMap<&str, &str>) -> String {
    match kv.get("15").copied() {
        Some("0") => "Tiny",
        Some("1") => "Short",
        Some("2") => "Medium",
        Some("3") => "Long",
        Some("4") => "XL",
        Some("5") => "Platformer",
        _ => "Unknown",
    }
    .to_owned()
}

/// Returns `(name, artist, id)` for the level's song, resolving official tracks or custom Newgrounds songs.
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
        tracing::warn!(
            song_id = target_id,
            "custom song ID present but song section missing"
        );
        return (
            "Unknown".to_owned(),
            "Unknown".to_owned(),
            target_id.parse().unwrap_or(0),
        );
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
    (
        "Unknown".to_owned(),
        "Unknown".to_owned(),
        target_id.parse().unwrap_or(0),
    )
}
