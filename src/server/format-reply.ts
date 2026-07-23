import type {LevelInfo} from './boomlings.ts'

export const FOOTER =
  '^(Automated) ^| ^by ^[sayajiaji](https://www.reddit.com/user/Sayajiaji) ^| ^[instructions](https://www.reddit.com/r/geometrydash/wiki/bot) ^| ^[source](https://github.com/cl3847/rgd-zbot/)'
export const FOOTER_MARKER = 'github.com/cl3847/rgd-zbot'

export function formatReply(info: LevelInfo): string {
  let block = `**[${info.name}](https://gdbrowser.com/${info.id})** by ${info.creatorUsername} (${info.id})`
  const description = info.description.trim()
  if (description) {
    block += `\n\n> ${description.replace(/[\r\n]/g, ' ')}`
  }

  const downloads = info.downloads.toLocaleString('en-US')
  const likes = info.likes.toLocaleString('en-US')
  block += `\n\n${info.difficulty} · ${info.stars}★ · ${info.length} · ${downloads} downloads · ${likes} likes  \n*${info.songName}* by ${info.songArtist}`

  return `${block}\n\n___\n\n${FOOTER}`
}
