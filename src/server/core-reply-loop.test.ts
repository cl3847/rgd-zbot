import assert from 'node:assert/strict'
import test from 'node:test'
import {findLevelId} from '../shared/level-id.ts'
import {
  BoomlingsProtocolError,
  type LevelInfo,
  lookupLevel,
} from './boomlings.ts'
import {FOOTER, formatReply} from './format-reply.ts'
import {
  type ClaimLease,
  type ProcessDependencies,
  processPost,
} from './process-post.ts'

const LEVEL_ID = '10565740'
const POST_ID = 't3_bloodbath' as const
const FOOTER_FROM_RUST =
  '^(Automated) ^| ^by ^[sayajiaji](https://www.reddit.com/user/Sayajiaji) ^| ^[instructions](https://www.reddit.com/r/geometrydash/wiki/bot) ^| ^[source](https://github.com/cl3847/rgd-zbot/)'

const COMPLETE_BOOMLINGS_RESPONSE = [
  [
    '1',
    LEVEL_ID,
    '2',
    'Bloodbath',
    '3',
    'QSBsZWdlbmRhcnkgbGV2ZWwKd2l0aCBibG9vZC4=',
    '6',
    '503085',
    '9',
    '50',
    '10',
    '1234567',
    '11',
    '0',
    '14',
    '-1234',
    '15',
    '3',
    '17',
    '1',
    '18',
    '10',
    '25',
    '0',
    '35',
    '999999',
    '43',
    '6',
  ].join(':'),
  '503085:Riot:123456',
  '1~|~999999~|~2~|~At the Speed of Light~|~4~|~Dimrain47',
].join('#')

const EXPECTED_REPLY = `**[Bloodbath](https://gdbrowser.com/${LEVEL_ID})** by Riot (${LEVEL_ID})

> A legendary level with blood.

Extreme Demon · 10★ · Long · 1,234,567 downloads · -1,234 likes  
*At the Speed of Light* by Dimrain47

___

${FOOTER_FROM_RUST}`

test('turns one qualifying post event into one complete parity reply', async () => {
  const claims = new Set<string>()
  let activeLease: ClaimLease | undefined
  let state: 'promotion' | 'not-found' | 'unresolved' | 'confirmed' | undefined
  const submitted: Array<{postId: string; text: string}> = []
  let fetchCount = 0

  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCount += 1
    assert.equal(input, 'https://www.boomlings.com/database/getGJLevels21.php')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(init?.headers, {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': '',
    })
    assert.ok(init?.body instanceof URLSearchParams)
    assert.equal(init.body.get('secret'), 'Wmfd2893gb7')
    assert.equal(init.body.get('type'), '0')
    assert.equal(init.body.get('str'), LEVEL_ID)
    assert.equal(init.body.get('count'), '1')
    return new Response(COMPLETE_BOOMLINGS_RESPONSE)
  }

  const dependencies: ProcessDependencies = {
    now: () => 1_752_580_000_000,
    getAppUsername: async () => 'rgeometrydash',
    resumePromotion: async () => undefined,
    claim: async postId => {
      if (claims.has(postId)) return undefined
      claims.add(postId)
      activeLease = {token: 'walking-skeleton', kind: 'fresh'}
      return activeLease
    },
    release: async (postId, lease) => {
      if (activeLease?.token !== lease.token) return
      claims.delete(postId)
      activeLease = undefined
    },
    retain: async (_postId, lease, terminal) => {
      if (activeLease?.token !== lease.token) return false
      state = terminal
      activeLease = undefined
      return true
    },
    promote: async (_postId, lease) => {
      if (activeLease?.token !== lease.token) return 'lost'
      state = 'promotion'
      return 'authorized'
    },
    inspectPromotion: async (_postId, lease) =>
      activeLease?.token === lease.token && state === 'promotion'
        ? 'authorized'
        : 'lost',
    authorizeWrite: async (_postId, lease) =>
      activeLease?.token === lease.token && state === 'promotion',
    reconcile: async () => 'inconclusive',
    lookup: id => lookupLevel(id, fetchImpl),
    format: level => {
      assert.deepEqual(level, {
        id: LEVEL_ID,
        name: 'Bloodbath',
        description: 'A legendary level\nwith blood.',
        creatorUsername: 'Riot',
        difficulty: 'Extreme Demon',
        stars: 10,
        downloads: 1_234_567,
        likes: -1_234,
        length: 'Long',
        songName: 'At the Speed of Light',
        songArtist: 'Dimrain47',
        songId: 999_999,
        isOfficialSong: false,
      })
      return formatReply(level)
    },
    submitComment: async (postId, text) => {
      submitted.push({postId, text})
      return {id: 't1_reply'}
    },
    log: () => {},
  }

  const result = await processPost(
    {
      id: POST_ID,
      title: `My level ID: ${LEVEL_ID}`,
      authorName: 'Riot',
      createdAt: 1_752_580_000,
    },
    dependencies,
  )

  assert.deepEqual(result, {
    status: 'replied',
    levelId: LEVEL_ID,
    commentId: 't1_reply',
  })
  assert.equal(fetchCount, 1)
  assert.deepEqual(submitted, [{postId: POST_ID, text: EXPECTED_REPLY}])
  assert.equal(FOOTER, FOOTER_FROM_RUST)
  assert.equal(submitted[0]?.text.includes('newgrounds.com'), false)
  assert.equal(submitted[0]?.text.includes('(999999)'), false)
})

test('extracts both ordered Rust-parity title forms within digit bounds', () => {
  assert.equal(findLevelId('id=123456'), '123456')
  assert.equal(findLevelId('try this [1234567890] now'), '1234567890')
  assert.equal(findLevelId('id 12345'), undefined)
  assert.equal(findLevelId('id 12345678901'), undefined)
})

test('returns null for not-found and returned-ID mismatch responses', async () => {
  assert.equal(
    await lookupLevel('99999999', async () => new Response('  -1\r\n')),
    null,
  )
  assert.equal(
    await lookupLevel(
      LEVEL_ID,
      async () => new Response('1:12345678:2:Different Level#'),
    ),
    null,
  )
})

test('throws a disclosure-safe protocol error for malformed response data', async () => {
  const malformed = `${'not-level-data'.repeat(20)}\r\nsecret-tail`
  await assert.rejects(
    lookupLevel(LEVEL_ID, async () => new Response(malformed)),
    error => {
      assert.ok(error instanceof BoomlingsProtocolError)
      assert.equal(error.message.includes('\r'), false)
      assert.equal(error.message.includes('\n'), false)
      assert.equal(error.message.includes('secret-tail'), false)
      return true
    },
  )
})

test('formats official songs without a link or visible song ID', () => {
  const officialLevel: LevelInfo = {
    id: '12345678',
    name: 'Official Test',
    description: '',
    creatorUsername: '-',
    difficulty: 'Easy',
    stars: 2,
    downloads: 10,
    likes: 5,
    length: 'Short',
    songName: 'Back on Track',
    songArtist: 'RobTop',
    songId: 1,
    isOfficialSong: true,
  }
  const reply = formatReply(officialLevel)
  assert.ok(reply.includes('*Back on Track* by RobTop'))
  assert.equal(reply.includes('newgrounds.com'), false)
  assert.equal(reply.includes('(1)'), false)
  assert.ok(reply.endsWith(FOOTER_FROM_RUST))
})
