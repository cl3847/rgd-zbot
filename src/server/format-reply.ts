import type {LevelInfo} from './boomlings.ts'

export const FOOTER =
  '^(Automated) ^| ^by ^[sayajiaji](https://www.reddit.com/user/Sayajiaji) ^| ^[instructions](https://www.reddit.com/r/geometrydash/wiki/bot) ^| ^[source](https://github.com/cl3847/rgd-zbot/)'
export const FOOTER_MARKER = 'github.com/cl3847/rgd-zbot'

// Song IDs at or above this come from RobTop's music library, not Newgrounds.
const NEWGROUNDS_SONG_ID_LIMIT = 10_000_000

export function formatReply(info: LevelInfo): string {
  let block = `**[${escapeMarkdown(info.name)}](https://gdbrowser.com/${info.id})** by ${escapeMarkdown(info.creatorUsername)} (${info.id})`
  const description = info.description.trim()
  if (description) {
    block += `\n\n> ${escapeMarkdown(description.replace(/[\r\n]/g, ' '))}`
  }

  const downloads = info.downloads.toLocaleString('en-US')
  const likes = info.likes.toLocaleString('en-US')
  const rating = info.rating ? ` · **${info.rating}**` : ''
  block += `\n\n${info.difficulty} · ${info.stars}★${rating} · ${info.length} · ${downloads} downloads · ${likes} likes  \n*${formatSongName(info)}* by ${escapeMarkdown(info.songArtist)}`

  return `${block}\n\n___\n\n${FOOTER}`
}

function formatSongName(info: LevelInfo): string {
  const name = escapeMarkdown(info.songName)
  if (
    info.isOfficialSong ||
    info.songId <= 0 ||
    info.songId >= NEWGROUNDS_SONG_ID_LIMIT
  ) {
    return name
  }
  return `[${name}](https://www.newgrounds.com/audio/listen/${info.songId})`
}

// Level text is player-written; backslash-escape every character Reddit
// Markdown treats as syntax so it renders literally and cannot add links,
// formatting, or u/ and r/ mentions to the bot's reply.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!:|&<>/^~]/g, '\\$&')
}
