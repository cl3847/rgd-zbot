mod gd;
mod reddit;

use anyhow::Context as _;

const REDDIT_USER_AGENT: &str = "nodejs:rgd-zbot:v2.0.0 (by /u/Sayajiaji)";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().without_time().init();

    let client_id = std::env::var("REDDIT_CLIENT_ID").context("REDDIT_CLIENT_ID not set")?;
    let client_secret =
        std::env::var("REDDIT_CLIENT_SECRET").context("REDDIT_CLIENT_SECRET not set")?;
    let username = std::env::var("REDDIT_USERNAME").context("REDDIT_USERNAME not set")?;
    let password = std::env::var("REDDIT_PASSWORD").context("REDDIT_PASSWORD not set")?;

    let me = roux::Reddit::new(REDDIT_USER_AGENT, &client_id, &client_secret)
        .username(&username)
        .password(&password)
        .login()
        .await?;

    reddit::run(me).await?;

    Ok(())
}
