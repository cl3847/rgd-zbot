import assert from 'node:assert/strict'
import test from 'node:test'
import type {LevelInfo} from './boomlings.ts'
import {FOOTER, formatReply} from './format-reply.ts'

const EXPECTED_FOOTER =
  '^(Automated) ^| ^by ^[sayajiaji](https://www.reddit.com/user/Sayajiaji) ^| ^[instructions](https://www.reddit.com/r/geometrydash/wiki/bot) ^| ^[source](https://github.com/cl3847/rgd-zbot/)'

const LEVEL: LevelInfo = {
  id: '12345678',
  name: 'Test Level',
  description: 'A test description',
  creatorUsername: 'creator',
  difficulty: 'Hard',
  rating: null,
  stars: 6,
  downloads: 1_234_567,
  likes: -1_234,
  length: 'Long',
  songName: 'Cool Song',
  songArtist: 'Some Artist',
  songId: 999_999,
  isOfficialSong: false,
}

test('REPLY-01 and D-08/D-09 lock the complete reply bytes and footer', () => {
  const expected = `**[Test Level](https://gdbrowser.com/12345678)** by creator (12345678)

> A test description

Hard · 6★ · Long · 1,234,567 downloads · -1,234 likes  
*[Cool Song](https://www.newgrounds.com/audio/listen/999999)* by Some Artist

___

${EXPECTED_FOOTER}`
  assert.equal(FOOTER, EXPECTED_FOOTER)
  assert.equal(formatReply(LEVEL), expected)
})

test('REPLY-01 flattens CR/LF descriptions and omits empty descriptions', () => {
  const flattened = formatReply({
    ...LEVEL,
    description: ' line one\r\nline two\n ',
  })
  assert.ok(flattened.includes('> line one  line two'))
  assert.equal(flattened.includes('\r'), false)

  for (const description of ['', '  \r\n  ']) {
    assert.equal(formatReply({...LEVEL, description}).includes('\n\n>'), false)
  }
})

test('REPLY-01 groups downloads and preserves negative likes', () => {
  const reply = formatReply(LEVEL)
  assert.ok(reply.includes('1,234,567 downloads'))
  assert.ok(reply.includes('-1,234 likes'))
})

test('links Newgrounds custom songs by song ID', () => {
  const reply = formatReply(LEVEL)
  assert.ok(
    reply.includes(
      '*[Cool Song](https://www.newgrounds.com/audio/listen/999999)* by Some Artist',
    ),
  )
  assert.equal(reply.includes('(999999)'), false)
})

test('keeps music library and unresolved custom songs link-free', () => {
  for (const songId of [10_000_000, 10_009_967, 0]) {
    const reply = formatReply({...LEVEL, songId})
    assert.ok(reply.includes('*Cool Song* by Some Artist'))
    assert.equal(reply.includes('newgrounds.com'), false)
  }
})

test('keeps official songs link-free with no visible ID', () => {
  const reply = formatReply({
    ...LEVEL,
    songName: 'Back on Track',
    songArtist: 'RobTop',
    songId: 1,
    isOfficialSong: true,
  })
  assert.ok(reply.includes('*Back on Track* by RobTop'))
  assert.equal(reply.includes('newgrounds.com'), false)
  assert.equal(reply.includes('audio/listen'), false)
  assert.equal(reply.includes('RobTop (1)'), false)
})

test('D-10 keeps the Phase 1 reply as plain parity Markdown', () => {
  const reply = formatReply(LEVEL)
  assert.equal(reply.includes('<img'), false)
  assert.equal(reply.includes('!['), false)
  assert.ok(reply.includes('Hard · 6★ · Long'))
})

test('shows the rating in bold after the stars', () => {
  for (const rating of ['Featured', 'Epic', 'Legendary', 'Mythic'] as const) {
    const reply = formatReply({...LEVEL, rating})
    assert.ok(reply.includes(`Hard · 6★ · **${rating}** · Long`))
  }
})

test('escapes Markdown in player-written level text', () => {
  const reply = formatReply({
    ...LEVEL,
    name: '[click](https://evil.example)',
    creatorUsername: 'some_one',
    description: 'u/spez **bold** \\[*0*]/ # heading',
    songName: 'F-777 - Sonic Blaster',
    songArtist: '^super ~~strike~~',
  })
  assert.ok(
    reply.startsWith(
      String.raw`**[\[click\]\(https\:\/\/evil\.example\)](https://gdbrowser.com/12345678)** by some\_one (12345678)`,
    ),
  )
  assert.ok(
    reply.includes(String.raw`> u\/spez \*\*bold\*\* \\\[\*0\*\]\/ \# heading`),
  )
  assert.ok(
    reply.includes(
      String.raw`*[F\-777 \- Sonic Blaster](https://www.newgrounds.com/audio/listen/999999)* by \^super \~\~strike\~\~`,
    ),
  )
  assert.equal(reply.includes('](https://evil'), false)
})
