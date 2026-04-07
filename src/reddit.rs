//! Reddit bot logic: authenticated subreddit polling, ID extraction, and reply posting.

use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use regex::Regex;
use roux::Me;
use roux::util::RouxError;
use serde::Deserialize;
use tokio::time::{sleep, timeout};

use crate::gd::{LevelInfo, search_level};

/// Subreddit the bot monitors for new posts.
const SUBREDDIT: &str = "geometrydash";
/// Four seconds stays comfortably under Reddit's 60 req/min OAuth guidance while still feeling realtime.
const POLL_INTERVAL: Duration = Duration::from_secs(4);
/// Posts older than this many seconds are ignored to avoid replying to stale content.
const MAX_AGE_SECS: u64 = 60;
/// Maximum number of posts to fetch per poll request.
const LISTING_LIMIT: u32 = 100;
/// Timeout applied to each Reddit listing HTTP request.
const POLL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Timeout applied to each Boomlings level lookup.
const LEVEL_LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);
/// Timeout applied to each Reddit comment submission.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
/// Timeout applied to locating and moderating a newly posted bot comment.
const MOD_ACTION_TIMEOUT: Duration = Duration::from_secs(15);
/// Maximum number of post IDs retained in the seen-post deduplication cache.
const SEEN_ID_CAPACITY: usize = 500;
/// Number of recent bot comments inspected when locating the just-posted reply.
const RECENT_COMMENT_LOOKUP_LIMIT: u32 = 10;
/// Reddit superscript footer appended to every bot reply.
const FOOTER: &str = "^this ^is ^an ^automated ^message. ^| ^by ^[sayajiaji](https://www.reddit.com/user/Sayajiaji) ^| ^[instructions](https://www.reddit.com/r/geometrydash/wiki/bot) | ^[source/contribute](https://github.com/cl3847/rgd-zbot/)";

/// Credentials and metadata required to create or refresh an authenticated Reddit session.
#[derive(Clone)]
pub struct RedditAuth {
    pub user_agent: String,
    pub client_id: String,
    pub client_secret: String,
    pub username: String,
    pub password: String,
}

impl RedditAuth {
    /// Logs in to Reddit and returns a fresh OAuth session.
    pub async fn login(&self) -> Result<Me> {
        Ok(
            roux::Reddit::new(&self.user_agent, &self.client_id, &self.client_secret)
                .username(&self.username)
                .password(&self.password)
                .login()
                .await?,
        )
    }
}

/// Minimal submission fields we read from Reddit's listing response.
///
/// We define our own type instead of relying on roux's `SubmissionData` because Reddit can return
/// negative integers for fields roux types as `u64`, causing deserialization failures.
#[derive(Deserialize)]
struct Submission {
    /// Short alphanumeric post ID (e.g. `"abc123"`), used for deduplication and logging.
    pub id: String,
    /// Fullname with type prefix (e.g. `"t3_abc123"`), used as the comment parent.
    pub name: String,
    pub title: String,
    pub author: String,
    pub created_utc: f64,
}

/// Wrapper types for deserializing a Reddit listing response.
#[derive(Deserialize)]
struct Listing {
    data: ListingData,
}

#[derive(Deserialize)]
struct ListingData {
    children: Vec<ListingChild>,
}

#[derive(Deserialize)]
struct ListingChild {
    data: Submission,
}

/// Result of polling the latest subreddit listing.
enum FetchOutcome {
    Success(Vec<Submission>),
    Unauthorized,
}

/// Result of polling the bot's own recent comment listing.
enum FetchOutcomeComments {
    Success(Vec<roux::comment::CommentData>),
    Unauthorized,
}

/// Compiled regexes for extracting a GD level ID from a post title; group 1 is the ID in both.
static ID_PATTERNS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        // "id 12345678", "ID: 12345678", "id=12345678", "(id 12345678)" etc.
        Regex::new(r"(?i)(?:^|[ .?!\-\(\[])id(?: is|[:=])? ?([0-9]{6,10})\b").unwrap(),
        // "[12345678]" or "(12345678)", with optional backslash escaping
        Regex::new(r"(?:^| )\\?[\[\(]([0-9]{6,10})\\?[\]\)](?:$| )").unwrap(),
    ]
});

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
        // Keep the legacy bot's `6* (Hard)` presentation for compatibility with existing output.
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

/// Scans a post title for a GD level ID. Returns the first match, or `None`.
pub fn find_level_id(title: &str) -> Option<String> {
    ID_PATTERNS
        .iter()
        .find_map(|re| re.captures(title)?.get(1).map(|m| m.as_str().to_owned()))
}

/// Assembles the full reply: the level block, a horizontal rule, and the bot footer.
pub fn format_reply(info: &LevelInfo) -> String {
    format!("{}\n\n___\n\n{}", PostReplyBlock(info), FOOTER)
}

/// Truncates a response body to at most 200 characters and flattens newlines for log messages.
fn response_preview(body: &str) -> String {
    const LIMIT: usize = 200;
    body.chars()
        .take(LIMIT)
        .collect::<String>()
        .replace(['\n', '\r'], " ")
}

/// Returns an exponentially stepped backoff duration for a given consecutive failure count.
fn failure_backoff_delay(failure_streak: u32) -> Duration {
    const STEPS_SECS: &[u64] = &[4, 8, 16, 32, 60];
    let idx = failure_streak.saturating_sub(1) as usize;
    Duration::from_secs(STEPS_SECS[idx.min(STEPS_SECS.len() - 1)])
}

/// Adds a post ID to the seen-set, evicting the oldest entry when at capacity. Returns `true` if new.
fn remember_seen(
    id: String,
    seen_ids: &mut HashSet<String>,
    seen_order: &mut VecDeque<String>,
) -> bool {
    if !seen_ids.insert(id.clone()) {
        return false;
    }
    seen_order.push_back(id);
    if seen_order.len() > SEEN_ID_CAPACITY
        && let Some(evicted) = seen_order.pop_front()
    {
        seen_ids.remove(&evicted);
    }
    true
}

/// Returns true when a roux error is a 401 status response.
fn is_unauthorized_roux_error(error: &RouxError) -> bool {
    matches!(error, RouxError::Status(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED)
}

/// Replaces the current Reddit session with a freshly authenticated one.
async fn refresh_session(auth: &RedditAuth, me: &mut Me) -> Result<()> {
    tracing::warn!("refreshing expired Reddit OAuth session");
    *me = auth.login().await?;
    Ok(())
}

/// Fetches the most recent posts from the monitored subreddit via the OAuth listing endpoint.
async fn fetch_latest_submissions(me: &Me) -> Result<FetchOutcome> {
    let url = format!(
        "{}?limit={LISTING_LIMIT}",
        roux::util::url::build_oauth(&format!("r/{SUBREDDIT}/new"))
    );
    let response = me
        .client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("request failed: {e}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<missing>")
        .to_owned();
    let body = response
        .text()
        .await
        .map_err(|e| anyhow!("failed reading response body: {e}"))?;

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(FetchOutcome::Unauthorized);
    }

    if !status.is_success() {
        bail!(
            "status={} content_type={} body_prefix={:?}",
            status,
            content_type,
            response_preview(&body)
        );
    }

    if !content_type.contains("json") {
        bail!(
            "unexpected content_type={} body_prefix={:?}",
            content_type,
            response_preview(&body)
        );
    }

    let listing: Listing = serde_json::from_str(&body).map_err(|e| {
        anyhow!(
            "failed to decode Reddit listing: {e}; status={}; content_type={}; body_prefix={:?}",
            status,
            content_type,
            response_preview(&body)
        )
    })?;

    Ok(FetchOutcome::Success(
        listing
            .data
            .children
            .into_iter()
            .map(|item| item.data)
            .collect(),
    ))
}

/// Fetches the bot's most recent comments and returns them, or `Unauthorized` if the token expired.
async fn fetch_recent_own_comments(me: &Me) -> Result<FetchOutcomeComments> {
    let username = me
        .config
        .username
        .as_deref()
        .ok_or_else(|| anyhow!("logged-in Reddit username missing from session config"))?;
    let url = format!(
        "https://oauth.reddit.com/user/{username}/comments/.json?limit={RECENT_COMMENT_LOOKUP_LIMIT}"
    );
    let response = me
        .client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("request failed: {e}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<missing>")
        .to_owned();
    let body = response
        .text()
        .await
        .map_err(|e| anyhow!("failed reading response body: {e}"))?;

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(FetchOutcomeComments::Unauthorized);
    }

    if !status.is_success() {
        bail!(
            "status={} content_type={} body_prefix={:?}",
            status,
            content_type,
            response_preview(&body)
        );
    }

    if !content_type.contains("json") {
        bail!(
            "unexpected content_type={} body_prefix={:?}",
            content_type,
            response_preview(&body)
        );
    }

    let comments: roux::Comments = serde_json::from_str(&body).map_err(|e| {
        anyhow!(
            "failed to decode Reddit comments listing: {e}; status={}; content_type={}; body_prefix={:?}",
            status,
            content_type,
            response_preview(&body)
        )
    })?;

    Ok(FetchOutcomeComments::Success(
        comments
            .data
            .children
            .into_iter()
            .map(|item| item.data)
            .collect(),
    ))
}

/// Locates the most recent bot comment on the given submission, or `None` if not found.
async fn find_reply_fullname(
    auth: &RedditAuth,
    me: &mut Me,
    reply: &str,
    submission_fullname: &str,
) -> Result<Option<String>> {
    let mut refreshed = false;

    loop {
        let comments = match timeout(MOD_ACTION_TIMEOUT, fetch_recent_own_comments(me)).await {
            Ok(Ok(FetchOutcomeComments::Success(comments))) => comments,
            Ok(Ok(FetchOutcomeComments::Unauthorized)) if !refreshed => {
                refresh_session(auth, me).await?;
                refreshed = true;
                continue;
            }
            Ok(Ok(FetchOutcomeComments::Unauthorized)) => {
                bail!("unauthorized after refreshing Reddit session")
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => bail!(
                "timed out fetching recent bot comments after {}s",
                MOD_ACTION_TIMEOUT.as_secs()
            ),
        };

        return Ok(comments.into_iter().find_map(|comment| {
            if comment.link_id.as_deref() == Some(submission_fullname)
                && comment.parent_id.as_deref() == Some(submission_fullname)
                && comment.body.as_deref() == Some(reply)
            {
                comment.name
            } else {
                None
            }
        }));
    }
}

/// Distinguishes and stickies a moderator comment, refreshing the OAuth session once if needed.
async fn sticky_comment(auth: &RedditAuth, me: &mut Me, comment_fullname: &str) -> Result<()> {
    let mut refreshed = false;

    loop {
        let form = [
            ("api_type", "json"),
            ("how", "yes"),
            ("sticky", "true"),
            ("id", comment_fullname),
        ];
        let result = timeout(
            MOD_ACTION_TIMEOUT,
            me.client
                .post("https://oauth.reddit.com/api/distinguish")
                .form(&form)
                .send(),
        )
        .await;

        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(anyhow!("request failed: {error}")),
            Err(_) => bail!(
                "timed out distinguishing comment after {}s",
                MOD_ACTION_TIMEOUT.as_secs()
            ),
        };

        if response.status() == reqwest::StatusCode::UNAUTHORIZED && !refreshed {
            refresh_session(auth, me).await?;
            refreshed = true;
            continue;
        }

        if !response.status().is_success() {
            let status = response.status();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("<missing>")
                .to_owned();
            let body = response
                .text()
                .await
                .map_err(|e| anyhow!("failed reading response body: {e}"))?;
            bail!(
                "status={} content_type={} body_prefix={:?}",
                status,
                content_type,
                response_preview(&body)
            );
        }

        return Ok(());
    }
}

/// Posts a reply to a submission, then distinguishes and stickies the resulting comment.
async fn post_reply(
    auth: &RedditAuth,
    me: &mut Me,
    reply: &str,
    submission_fullname: &str,
    post_id: &str,
    level_id: &str,
) {
    let mut refreshed = false;

    loop {
        let result = timeout(REPLY_TIMEOUT, me.comment(reply, submission_fullname)).await;
        match result {
            Ok(Ok(_)) => {
                tracing::info!(post = post_id, level_id, "replied");
                match find_reply_fullname(auth, me, reply, submission_fullname).await {
                    Ok(Some(comment_fullname)) => {
                        if let Err(error) = sticky_comment(auth, me, &comment_fullname).await {
                            tracing::warn!(
                                post = post_id,
                                comment = comment_fullname,
                                "failed to distinguish/sticky reply: {error}"
                            );
                        }
                    }
                    Ok(None) => {
                        tracing::warn!(
                            post = post_id,
                            "posted reply but could not locate comment to distinguish/sticky"
                        );
                    }
                    Err(error) => {
                        tracing::warn!(
                            post = post_id,
                            "posted reply but failed locating comment for moderation: {error}"
                        );
                    }
                }
                return;
            }
            Ok(Err(ref error)) if !refreshed && is_unauthorized_roux_error(error) => {
                if let Err(refresh_error) = refresh_session(auth, me).await {
                    tracing::warn!(
                        post = post_id,
                        "failed to refresh Reddit session: {refresh_error}"
                    );
                    return;
                }
                refreshed = true;
            }
            Ok(Err(error)) => {
                tracing::warn!(post = post_id, "failed to post reply: {error}");
                return;
            }
            Err(_) => {
                tracing::warn!(
                    post = post_id,
                    level_id,
                    timeout_secs = REPLY_TIMEOUT.as_secs(),
                    "timed out posting reply"
                );
                return;
            }
        }
    }
}

/// Processes a single Reddit submission: extracts a level ID, looks it up, and posts a reply.
async fn handle_submission(auth: &RedditAuth, me: &mut Me, submission: Submission) {
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => {
            tracing::warn!("system clock is before the Unix epoch; skipping post");
            return;
        }
    };

    if submission.created_utc < 0.0 {
        tracing::warn!(
            post = %submission.id,
            created_utc = submission.created_utc,
            "submission had negative created_utc"
        );
        return;
    }

    let created_secs = submission.created_utc as u64;
    let age_secs = now.saturating_sub(created_secs);
    let too_old = age_secs > MAX_AGE_SECS;
    let is_self = me.config.username.as_deref() == Some(submission.author.as_str());

    if too_old || is_self {
        tracing::debug!(
            post = %submission.id,
            age_secs,
            is_self,
            "skipping submission"
        );
        return;
    }

    tracing::info!(
        post = %submission.id,
        title = %submission.title,
        "new submission detected"
    );

    let Some(id) = find_level_id(&submission.title) else {
        return;
    };

    tracing::info!(post = %submission.id, level_id = %id, "found level ID");

    let level = match timeout(LEVEL_LOOKUP_TIMEOUT, search_level(&id)).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!(
                post = %submission.id,
                level_id = %id,
                timeout_secs = LEVEL_LOOKUP_TIMEOUT.as_secs(),
                "timed out looking up level"
            );
            return;
        }
    };

    match level {
        Ok(Some(info)) => {
            let reply = format_reply(&info);
            post_reply(auth, me, &reply, &submission.name, &submission.id, &id).await;
        }
        Ok(None) => tracing::info!(post = %submission.id, level_id = %id, "level not found"),
        Err(e) => tracing::warn!(post = %submission.id, level_id = %id, "API error: {e}"),
    }
}

/// Polls r/geometrydash and replies to posts containing a level ID.
pub async fn run(auth: RedditAuth) -> Result<()> {
    let mut me = auth.login().await?;
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_order: VecDeque<String> = VecDeque::with_capacity(SEEN_ID_CAPACITY);
    let mut failure_streak = 0_u32;

    tracing::info!(
        poll_interval_secs = POLL_INTERVAL.as_secs(),
        poll_timeout_secs = POLL_REQUEST_TIMEOUT.as_secs(),
        listing_limit = LISTING_LIMIT,
        "monitoring r/{SUBREDDIT}"
    );

    loop {
        let latest_submissions =
            match timeout(POLL_REQUEST_TIMEOUT, fetch_latest_submissions(&me)).await {
                Ok(Ok(FetchOutcome::Success(submissions))) => {
                    failure_streak = 0;
                    submissions
                }
                Ok(Ok(FetchOutcome::Unauthorized)) => {
                    refresh_session(&auth, &mut me).await?;
                    failure_streak = 0;
                    continue;
                }
                Ok(Err(e)) => {
                    failure_streak = failure_streak.saturating_add(1);
                    let backoff = failure_backoff_delay(failure_streak);
                    tracing::warn!(
                        failure_streak,
                        backoff_secs = backoff.as_secs(),
                        "failed to fetch latest submissions: {e}"
                    );
                    sleep(backoff).await;
                    continue;
                }
                Err(_) => {
                    failure_streak = failure_streak.saturating_add(1);
                    let backoff = failure_backoff_delay(failure_streak);
                    tracing::warn!(
                        failure_streak,
                        timeout_secs = POLL_REQUEST_TIMEOUT.as_secs(),
                        backoff_secs = backoff.as_secs(),
                        "timed out fetching latest submissions"
                    );
                    sleep(backoff).await;
                    continue;
                }
            };

        let mut num_new = 0;

        for submission in latest_submissions {
            let id = submission.id.clone();
            if remember_seen(id, &mut seen_ids, &mut seen_order) {
                num_new += 1;
                handle_submission(&auth, &mut me, submission).await;
            }
        }

        tracing::debug!(
            new_submissions = num_new,
            seen_cache_size = seen_ids.len(),
            "finished Reddit poll"
        );
        if num_new == LISTING_LIMIT as usize {
            tracing::warn!(
                listing_limit = LISTING_LIMIT,
                "every fetched submission was new; consider a shorter poll interval"
            );
        }

        sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::find_level_id;

    fn matches(title: &str) -> bool {
        find_level_id(title).is_some()
    }

    fn extracts(title: &str) -> String {
        find_level_id(title).expect("expected a match")
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
