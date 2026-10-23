# Privacy Policy

zbot is a Reddit app for r/geometrydash. When a post's title contains a Geometry Dash level ID, it looks the level up and replies with the level's details.

## What it reads

- The title, ID, author name and creation time of new posts in subreddits where it is installed.
- Comments on a post it is replying to, only to check whether it has already replied.

The author name is only compared against the app's own account so it never replies to itself. It is not stored.

## What it stores

- The ID of each post it has handled and whether it replied, so it never replies twice. This is kept in the app's Reddit-hosted storage.
- A short-lived lock on a post while it is being handled, which expires after 60 seconds.

No usernames, post text or other personal information is stored.

## What it sends elsewhere

- The level ID from the post title is sent to the Geometry Dash servers (www.boomlings.com) to look up the level. Nothing else about the post or its author is sent.

## Logs

The app logs which step each post reached (for example, level found or reply posted) with the post ID, level ID and reply ID. These logs are kept by Reddit as part of its developer platform.

## Contact

Questions or removal requests: message u/Sayajiaji on Reddit or open an issue at https://github.com/cl3847/rgd-zbot/issues.
