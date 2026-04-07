mod gd;
mod reddit;

use anyhow::Context as _;
use reddit::RedditAuth;

/// OAuth user-agent string sent with every Reddit API request.
const REDDIT_USER_AGENT: &str = "rust:rgd-zbot:v2.0.0 (by /u/Sayajiaji)";

/// Loads credentials from the environment, authenticates with Reddit, and starts the polling loop.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().without_time().init();

    let client_id = std::env::var("REDDIT_CLIENT_ID").context("REDDIT_CLIENT_ID not set")?;
    let client_secret =
        std::env::var("REDDIT_CLIENT_SECRET").context("REDDIT_CLIENT_SECRET not set")?;
    let username = std::env::var("REDDIT_USERNAME").context("REDDIT_USERNAME not set")?;
    let password = std::env::var("REDDIT_PASSWORD").context("REDDIT_PASSWORD not set")?;

    let auth = RedditAuth {
        user_agent: REDDIT_USER_AGENT.to_owned(),
        client_id,
        client_secret,
        username,
        password,
    };

    reddit::run(auth).await?;

    Ok(())
}
