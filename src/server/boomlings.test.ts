import assert from 'node:assert/strict'
import test from 'node:test'
import {BoomlingsProtocolError, lookupLevel} from './boomlings.ts'

const LEVEL_ID = '10565740'

function response(body: string, status = 200): Response {
  return new Response(body, {status})
}

function levelResponse(
  fields: Readonly<Record<string, string>> = {},
  creatorSection = '',
  songSection = '',
): string {
  const base: Record<string, string> = {
    '1': LEVEL_ID,
    '2': 'Bloodbath',
    '3': '',
    '6': '503085',
    '9': '30',
    '10': '1000',
    '11': '0',
    '14': '50',
    '15': '3',
    '17': '0',
    '18': '6',
    '25': '0',
    '35': '0',
    ...fields,
  }
  return `${Object.entries(base).flat().join(':')}#${creatorSection}#${songSection}`
}

test('LOOKUP-01 sends the exact Boomlings form request and parses success', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://www.boomlings.com/database/getGJLevels21.php')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(init?.headers, {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': '',
    })
    assert.ok(init?.body instanceof URLSearchParams)
    assert.deepEqual(Object.fromEntries(init.body), {
      secret: 'Wmfd2893gb7',
      type: '0',
      str: LEVEL_ID,
      count: '1',
    })
    return response(levelResponse({}, '503085:Riot:123456'))
  }

  const level = await lookupLevel(LEVEL_ID, fetchImpl)
  assert.equal(level?.id, LEVEL_ID)
  assert.equal(level?.name, 'Bloodbath')
})

test('LOOKUP-01 treats -1 as not found and rejects HTTP failures', async () => {
  assert.equal(
    await lookupLevel(LEVEL_ID, async () => response(' \r\n-1\n')),
    null,
  )
  await assert.rejects(
    lookupLevel(LEVEL_ID, async () => response('unavailable', 503)),
    /HTTP 503/,
  )
})

test('LOOKUP-01 aborts a stalled request at the injected deadline', async () => {
  let observedSignal: AbortSignal | undefined
  const fetchImpl: typeof fetch = async (_input, init) => {
    observedSignal = init?.signal ?? undefined
    assert.ok(observedSignal)

    return await new Promise<Response>((_resolve, reject) => {
      const safetyTimer = setTimeout(
        () => reject(new Error('test safety timeout')),
        250,
      )
      observedSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(safetyTimer)
          reject(new Error('hostile transport detail must not escape'))
        },
        {once: true},
      )
    })
  }

  await assert.rejects(lookupLevel(LEVEL_ID, fetchImpl, 10), error => {
    assert.ok(error instanceof BoomlingsProtocolError)
    assert.equal(error.category, 'timeout')
    assert.equal(error.message, 'Boomlings request timed out')
    assert.equal(error.message.includes('hostile transport detail'), false)
    assert.equal(
      JSON.stringify(error).includes('hostile transport detail'),
      false,
    )
    return true
  })
  assert.equal(observedSignal?.aborted, true)
})

test('LOOKUP-01 validates IDs before making a request', async () => {
  let called = false
  await assert.rejects(
    lookupLevel('abc', async () => {
      called = true
      return response('-1')
    }),
    TypeError,
  )
  assert.equal(called, false)
})

test('LOOKUP-02 rejects malformed protocol data safely and treats ID mismatch as not found', async () => {
  const unsafe =
    'credential=TOPSECRET title=PRIVATE description=HIDDEN body=LEAKED:not-level-data'
  await assert.rejects(
    lookupLevel(LEVEL_ID, async () => response(unsafe)),
    error => {
      assert.ok(error instanceof BoomlingsProtocolError)
      assert.equal(error.category, 'malformed_response')
      assert.equal(error.message, 'Boomlings returned malformed level data')
      for (const forbidden of [
        'TOPSECRET',
        'PRIVATE',
        'HIDDEN',
        'LEAKED',
        unsafe,
      ]) {
        assert.equal(error.message.includes(forbidden), false)
        assert.equal(JSON.stringify(error).includes(forbidden), false)
      }
      return true
    },
  )
  assert.equal(
    await lookupLevel(LEVEL_ID, async () =>
      response(levelResponse({'1': '12345678'})),
    ),
    null,
  )
})

test('LOOKUP-01 HTTP errors expose only a stable category and safe status', async () => {
  const unsafe =
    'credential=TOPSECRET title=PRIVATE description=HIDDEN body=LEAKED'
  await assert.rejects(
    lookupLevel(LEVEL_ID, async () => response(unsafe, 503)),
    error => {
      assert.ok(error instanceof BoomlingsProtocolError)
      assert.equal(error.category, 'http_status')
      assert.equal(error.message, 'Boomlings request failed with HTTP 503')
      for (const forbidden of ['TOPSECRET', 'PRIVATE', 'HIDDEN', 'LEAKED']) {
        assert.equal(error.message.includes(forbidden), false)
        assert.equal(JSON.stringify(error).includes(forbidden), false)
      }
      return true
    },
  )
})

test('LOOKUP-02 parses creators safely and falls back to a guest dash', async () => {
  const found = await lookupLevel(LEVEL_ID, async () =>
    response(levelResponse({}, '503085:Riot:123456|broken')),
  )
  assert.equal(found?.creatorUsername, 'Riot')

  const guest = await lookupLevel(LEVEL_ID, async () =>
    response(levelResponse({'6': 'missing'}, '503085:Riot:123456')),
  )
  assert.equal(guest?.creatorUsername, '-')
})

test('LOOKUP-02 accepts the two canonical Rust base64 forms', async () => {
  const accepted = [
    ['fn5-', '~~~'],
    ['SGVsbG8td29ybGQ_', 'Hello-world?'],
    ['SGVsbG8=', 'Hello'],
    ['Lw==', '/'],
    ['fn5+', '~~~'],
  ] as const

  for (const [encoded, expected] of accepted) {
    const level = await lookupLevel(LEVEL_ID, async () =>
      response(levelResponse({'3': encoded})),
    )
    assert.equal(level?.description, expected)
  }
})

test('LOOKUP-02 rejects malformed, non-canonical, and non-UTF-8 descriptions', async t => {
  const rejected = {
    'embedded illegal character': 'SGV!sbG8=',
    'mixed alphabets': '-_+/',
    'impossible encoded length': 'A',
    'misplaced padding': 'SG=VsbG8=',
    'excess padding': 'SGVsbG8===',
    'padding in URL-safe form': '_w==',
    'non-canonical standard trailing bits': 'Zh==',
    'non-canonical URL-safe trailing bits': 'Zh',
    'invalid UTF-8': '/w==',
  } as const

  for (const [name, encoded] of Object.entries(rejected)) {
    await t.test(name, async () => {
      const level = await lookupLevel(LEVEL_ID, async () =>
        response(levelResponse({'3': encoded})),
      )
      assert.equal(level?.description, '')
    })
  }
})

test('LOOKUP-02 preserves empty and whitespace description fallback', async () => {
  for (const encoded of ['', 'ICAKICA=']) {
    const level = await lookupLevel(LEVEL_ID, async () =>
      response(levelResponse({'3': encoded})),
    )
    assert.equal(level?.description, '')
  }
})

test('LOOKUP-02 defaults malformed and unsafe numeric fields without unsafe indexing', async () => {
  const level = await lookupLevel(LEVEL_ID, async () =>
    response(
      levelResponse({
        '10': '-1',
        '14': 'not-a-number',
        '18': '9007199254740992',
        '35': 'broken',
      }),
    ),
  )
  assert.equal(level?.downloads, 0)
  assert.equal(level?.likes, 0)
  assert.equal(level?.stars, 0)
  assert.equal(level?.songId, 0)
  assert.equal(level?.songName, 'Unknown')
})

test('LOOKUP-03 maps every difficulty and honors demon then auto precedence', async t => {
  const cases: ReadonlyArray<readonly [Record<string, string>, string]> = [
    [{'9': '10'}, 'Easy'],
    [{'9': '20'}, 'Normal'],
    [{'9': '30'}, 'Hard'],
    [{'9': '40'}, 'Harder'],
    [{'9': '50'}, 'Insane'],
    [{'9': '0'}, 'N/A'],
    [{'25': '1', '9': '50'}, 'Auto'],
    [{'17': '1', '25': '1', '43': '3'}, 'Easy Demon'],
    [{'17': '1', '43': '4'}, 'Medium Demon'],
    [{'17': '1', '43': '5'}, 'Insane Demon'],
    [{'17': '1', '43': '6'}, 'Extreme Demon'],
    [{'17': '1', '43': '2'}, 'Hard Demon'],
  ]

  for (const [fields, expected] of cases) {
    await t.test(expected, async () => {
      const level = await lookupLevel(LEVEL_ID, async () =>
        response(levelResponse(fields)),
      )
      assert.equal(level?.difficulty, expected)
    })
  }
})

test('resolves the rating from the epic tier, then the featured score', async t => {
  const cases: ReadonlyArray<readonly [Record<string, string>, string | null]> =
    [
      [{}, null],
      [{'19': '0'}, null],
      [{'19': '-1'}, null],
      [{'19': '3206'}, 'Featured'],
      [{'19': '30568', '42': '1'}, 'Epic'],
      [{'19': '37751', '42': '2'}, 'Legendary'],
      [{'19': '40481', '42': '3'}, 'Mythic'],
      [{'19': '3206', '42': '9'}, 'Featured'],
    ]

  for (const [fields, expected] of cases) {
    await t.test(`${JSON.stringify(fields)} -> ${expected}`, async () => {
      const level = await lookupLevel(LEVEL_ID, async () =>
        response(levelResponse(fields)),
      )
      assert.equal(level?.rating, expected)
    })
  }
})

test('LOOKUP-04 maps every length and the unknown fallback', async () => {
  const cases = ['Tiny', 'Short', 'Medium', 'Long', 'XL', 'Platformer'] as const
  for (const [value, expected] of cases.entries()) {
    const level = await lookupLevel(LEVEL_ID, async () =>
      response(levelResponse({'15': `${value}`})),
    )
    assert.equal(level?.length, expected)
  }
  const unknown = await lookupLevel(LEVEL_ID, async () =>
    response(levelResponse({'15': '9'})),
  )
  assert.equal(unknown?.length, 'Unknown')
})

test('LOOKUP-05 resolves official, custom, missing, and mismatched songs', async () => {
  const official = await lookupLevel(LEVEL_ID, async () =>
    response(levelResponse({'11': '1'})),
  )
  assert.deepEqual(
    {
      name: official?.songName,
      artist: official?.songArtist,
      id: official?.songId,
      official: official?.isOfficialSong,
    },
    {name: 'Back on Track', artist: 'RobTop', id: 1, official: true},
  )

  const unknownOfficial = await lookupLevel(LEVEL_ID, async () =>
    response(levelResponse({'11': '999'})),
  )
  assert.equal(unknownOfficial?.songName, 'Unknown')

  const custom = await lookupLevel(LEVEL_ID, async () =>
    response(
      levelResponse(
        {'35': '999999'},
        '',
        '1~|~999999~|~2~|~Cool Song~|~4~|~Some Artist',
      ),
    ),
  )
  assert.deepEqual(
    {
      name: custom?.songName,
      artist: custom?.songArtist,
      id: custom?.songId,
      official: custom?.isOfficialSong,
    },
    {name: 'Cool Song', artist: 'Some Artist', id: 999999, official: false},
  )

  for (const section of ['', '1~|~123456~|~2~|~Wrong~|~4~|~Artist']) {
    const missing = await lookupLevel(LEVEL_ID, async () =>
      response(levelResponse({'35': '999999'}, '', section)),
    )
    assert.equal(missing?.songName, 'Unknown')
    assert.equal(missing?.songArtist, 'Unknown')
  }
})
