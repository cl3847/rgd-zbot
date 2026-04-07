//! Reddit bot logic: submission streaming, ID extraction, and reply posting.

use std::collections::HashSet;
use std::fmt;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use futures::StreamExt as _;
use regex::Regex;
use roux::Me;
use roux::subreddit::Subreddit;
use roux_stream::stream_submissions;
use tokio_retry::strategy::ExponentialBackoff;

use crate::gd::{LevelInfo, search_level};

const SUBREDDIT: &str = "geometrydash";
const POLL_INTERVAL: Duration = Duration::from_secs(4);
const MAX_AGE_SECS: u64 = 60;
const FOOTER: &str = "^this ^is ^an ^automated ^message. ^| ^by ^[sayajiaji](https://www.reddit.com/user/Sayajiaji) ^| ^[instructions](https://www.reddit.com/r/geometrydash/wiki/bot) | ^[source/contribute](https://github.com/cl3847/rgd-zbot/)";

// Both patterns capture the level ID in group 1.
static ID_PATTERNS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        // "id 12345678", "ID: 12345678", "id=12345678", "(id 12345678)" etc.
        Regex::new(r"(?i)(?:^|[ .?!\-\(\[])id(?: is|[:=])? ?([0-9]{6,10})\b").unwrap(),
        // "[12345678]" or "(12345678)", with optional backslash escaping
        Regex::new(r"(?:^| )\\?[\[\(]([0-9]{6,10})\\?[\]\)](?:$| )").unwrap(),
    ]
});

/// Scans a post title for a GD level ID. Returns the first match, or `None`.
pub fn find_level_id(title: &str) -> Option<String> {
    ID_PATTERNS
        .iter()
        .find_map(|re| re.captures(title)?.get(1).map(|m| m.as_str().to_owned()))
}

/// Reddit markdown block for a single level.
pub struct PostReplyBlock<'a>(pub &'a LevelInfo);

impl fmt::Display for PostReplyBlock<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let info = self.0;
        writeln!(
            f,
            "**Level:** *{}* by {} ({})  ",
            info.name, info.creator_username, info.id
        )?;
        if !info.description.is_empty() {
            // Newlines in the description would break out of the blockquote; flatten them.
            let desc = info.description.replace('\n', " ");
            write!(f, "**Description:**  \n> {desc}\n\n")?;
        }
        writeln!(f, "**Difficulty:** {}* ({})  ", info.stars, info.difficulty)?;
        writeln!(
            f,
            "**Stats:** {} downloads | {} likes | {}  ",
            info.downloads, info.likes, info.length
        )?;
        writeln!(
            f,
            "**Song:** *{}* by {} ({})  ",
            info.song_name, info.song_artist, info.song_id
        )
    }
}

/// Assembles the full reply: the level block, a horizontal rule, and the bot footer.
pub fn format_reply(info: &LevelInfo) -> String {
    format!("{}\n\n___\n\n{}", PostReplyBlock(info), FOOTER)
}

/// Polls r/geometrydash and replies to posts containing a level ID. Runs until
/// the underlying stream terminates.
pub async fn run(me: Me) -> Result<()> {
    let subreddit = Subreddit::new(SUBREDDIT);
    let retry = ExponentialBackoff::from_millis(5000).take(3);
    // _handle keeps the background polling task alive; dropping it stops the stream.
    let (mut stream, _handle) = stream_submissions(&subreddit, POLL_INTERVAL, retry, None);
    let mut seen: HashSet<String> = HashSet::new();

    tracing::info!("monitoring r/{SUBREDDIT}");

    while let Some(result) = stream.next().await {
        let submission = match result {
            Ok(sub) => sub,
            Err(e) => {
                println!("STREAM: error while polling Reddit: {e}");
                tracing::warn!("stream error: {e}");
                continue;
            }
        };

        let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs(),
            Err(_) => {
                tracing::warn!("system clock is before the Unix epoch; skipping post");
                continue;
            }
        };
        let created_secs = submission.created_utc.max(0.0) as u64;
        let age_secs = now.saturating_sub(created_secs);
        let too_old = age_secs > MAX_AGE_SECS;
        let is_self = me.config.username.as_deref() == Some(submission.author.as_str());
        let already_seen = seen.contains(&submission.id);

        println!(
            "STREAM: post={} age={}s seen={} self={} title={:?}",
            submission.id, age_secs, already_seen, is_self, submission.title
        );

        if already_seen {
            println!(
                "STREAM: skipping post={} because it was already seen",
                submission.id
            );
            continue;
        }
        if too_old {
            println!(
                "STREAM: skipping post={} because it is too old ({}s > {}s)",
                submission.id, age_secs, MAX_AGE_SECS
            );
            continue;
        }
        if is_self {
            println!(
                "STREAM: skipping post={} because author matches the bot account",
                submission.id
            );
            continue;
        }
        // Marked seen before the API call. A transient failure will not be retried,
        // but this prevents duplicate replies if the stream delivers the same post twice
        // while an in-flight request is still pending.
        seen.insert(submission.id.clone());

        let Some(id) = find_level_id(&submission.title) else {
            println!("STREAM: no level ID match for post={}", submission.id);
            continue;
        };

        println!("STREAM: matched level ID {id} for post={}", submission.id);
        tracing::info!(post = %submission.id, level_id = %id, "found level ID");

        match search_level(&id).await {
            Ok(Some(info)) => {
                if let Err(e) = me.comment(&format_reply(&info), &submission.name).await {
                    println!(
                        "STREAM: failed to reply to post={} error={e}",
                        submission.id
                    );
                    tracing::warn!(post = %submission.id, "failed to post reply: {e}");
                } else {
                    println!("STREAM: replied to post={} level_id={id}", submission.id);
                    tracing::info!(post = %submission.id, level_id = %id, "replied");
                }
            }
            Ok(None) => {
                println!(
                    "STREAM: level lookup returned no result for post={} level_id={id}",
                    submission.id
                );
                tracing::info!(post = %submission.id, level_id = %id, "level not found");
            }
            Err(e) => {
                println!(
                    "STREAM: level lookup failed for post={} level_id={} error={e}",
                    submission.id, id
                );
                tracing::warn!(post = %submission.id, level_id = %id, "API error: {e}");
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::find_level_id;

    fn matches(title: &str) -> bool {
        find_level_id(title).is_some()
    }

    fn extracts(title: &str) -> &str {
        Box::leak(
            find_level_id(title)
                .expect("expected a match")
                .into_boxed_str(),
        )
    }

    // ── pattern 1: explicit "id" keyword ─────────────────────────────────────

    #[test]
    fn id_space() {
        assert_eq!(extracts("id 12345678"), "12345678");
    }

    #[test]
    fn id_colon() {
        assert_eq!(extracts("ID: 12345678"), "12345678");
    }

    #[test]
    fn id_equals() {
        assert_eq!(extracts("id=12345678"), "12345678");
    }

    #[test]
    fn id_is_keyword() {
        assert_eq!(extracts("id is 12345678"), "12345678");
    }

    #[test]
    fn id_uppercase() {
        assert_eq!(extracts("ID 12345678"), "12345678");
    }

    #[test]
    fn id_mid_sentence() {
        assert_eq!(extracts("my level id 12345678 is cool"), "12345678");
    }

    #[test]
    fn id_after_punctuation() {
        assert_eq!(extracts("(id 12345678)"), "12345678");
        assert_eq!(extracts("[id 12345678]"), "12345678");
        assert_eq!(extracts("great level! id 12345678"), "12345678");
        assert_eq!(extracts("level.id 12345678"), "12345678");
        assert_eq!(extracts("-id 12345678"), "12345678");
    }

    #[test]
    fn id_at_start() {
        assert_eq!(extracts("id12345678 is a cool level"), "12345678");
    }

    // ── pattern 2: bracketed ─────────────────────────────────────────────────

    #[test]
    fn bracketed_square() {
        assert_eq!(extracts("[12345678]"), "12345678");
    }

    #[test]
    fn bracketed_paren() {
        assert_eq!(extracts("(12345678)"), "12345678");
    }

    #[test]
    fn bracketed_mid_sentence() {
        assert_eq!(extracts("check this level [12345678] out"), "12345678");
    }

    #[test]
    fn bracketed_escaped() {
        // Reddit sometimes backslash-escapes brackets in older post titles.
        assert_eq!(extracts(r"\[12345678\]"), "12345678");
    }

    // ── digit boundaries ─────────────────────────────────────────────────────

    #[test]
    fn exactly_six_digits() {
        assert_eq!(extracts("id 123456"), "123456");
    }

    #[test]
    fn exactly_ten_digits() {
        assert_eq!(extracts("id 1234567890"), "1234567890");
    }

    #[test]
    fn five_digits_no_match() {
        assert!(!matches("id 12345"));
    }

    #[test]
    fn eleven_digits_no_match() {
        // \b prevents a partial match — the greedy engine consumes 10 digits, then fails
        // the word-boundary check because the 11th character is still a digit.
        assert!(!matches("id 12345678901"));
    }

    // ── false positives ───────────────────────────────────────────────────────

    #[test]
    fn id_inside_word_no_match() {
        assert!(!matches("valid 12345678"));
        assert!(!matches("said 12345678"));
        assert!(!matches("rapid 12345678"));
        assert!(!matches("squid 12345678"));
        assert!(!matches("void12345678"));
    }

    #[test]
    fn bracketed_no_space_prefix_no_match() {
        assert!(!matches("abc[12345678]"));
        assert!(!matches("abc(12345678)"));
    }

    #[test]
    fn bare_number_no_match() {
        assert!(!matches("12345678"));
        assert!(!matches("I got 12345678 points"));
        assert!(!matches("chapter 12345678"));
    }

    #[test]
    fn long_number_in_url_no_match() {
        assert!(!matches("https://example.com/profile/12345678901"));
    }

    #[test]
    fn bracketed_no_closing_no_match() {
        assert!(!matches("[12345678"));
        assert!(!matches("(12345678"));
    }

    #[test]
    fn bracketed_followed_by_non_space_no_match() {
        // Trailing (?:$| ) rejects anything that isn't end-of-string or a space.
        assert!(!matches("[12345678]x"));
        assert!(!matches("[12345678],"));
    }

    // ── PostReplyBlock formatting ─────────────────────────────────────────────

    use crate::gd::LevelInfo;
    use crate::reddit::{PostReplyBlock, format_reply};

    fn sample_level() -> LevelInfo {
        LevelInfo {
            id: 12345678,
            name: "Test Level".to_owned(),
            description: "A test description".to_owned(),
            creator_username: "creator".to_owned(),
            difficulty: "Hard".to_owned(),
            stars: 6,
            downloads: 1000,
            likes: 50,
            length: "Long".to_owned(),
            song_name: "Cool Song".to_owned(),
            song_artist: "Some Artist".to_owned(),
            song_id: 999999,
        }
    }

    #[test]
    fn reply_block_contains_level_name() {
        let block = PostReplyBlock(&sample_level()).to_string();
        assert!(
            block.contains("*Test Level*"),
            "expected italicised level name"
        );
    }

    #[test]
    fn reply_block_difficulty_matches_legacy_format() {
        let block = PostReplyBlock(&sample_level()).to_string();
        assert!(
            block.contains("6*"),
            "expected star count with trailing asterisk"
        );
        assert!(
            !block.contains("*6*"),
            "did not expect italicised star count"
        );
        assert!(block.contains("(Hard)"), "expected difficulty in parens");
    }

    #[test]
    fn reply_block_omits_description_when_empty() {
        let mut info = sample_level();
        info.description = String::new();
        let block = PostReplyBlock(&info).to_string();
        assert!(
            !block.contains("Description"),
            "unexpected description line"
        );
    }

    #[test]
    fn reply_block_description_newlines_flattened() {
        let mut info = sample_level();
        info.description = "line one\nline two".to_owned();
        let block = PostReplyBlock(&info).to_string();
        assert!(
            !block.contains('\n') || block.lines().all(|l| !l.starts_with("line")),
            "raw newline leaked into blockquote"
        );
    }

    #[test]
    fn format_reply_contains_footer() {
        let reply = format_reply(&sample_level());
        assert!(reply.contains("automated"), "footer missing from reply");
        assert!(reply.contains("___"), "horizontal rule missing");
    }
}
