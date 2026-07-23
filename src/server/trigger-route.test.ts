import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, beforeEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {type Context, reddit, redis, runWithContext} from '@devvit/web/server'
import {Endpoint, type ErrorRsp} from '../shared/api.ts'
import {FOOTER_MARKER} from './format-reply.ts'
import {onReq} from './server.ts'

type CommentCandidate = {
  readonly authorName: string
  readonly body: string
  readonly parentId: string
}

type LeaseRecord = {
  value: string
  expiration: number
}

type PromotionFault = {
  readonly when: 'before' | 'after'
  readonly readFailuresAfter?: number
}

type ExecFault = 'before' | 'abort' | 'after'

type CapturedLog = {
  readonly severity: 'info' | 'warn' | 'error'
  readonly text: string
}

const CLAIM_KEY = 'rgd-zbot:claim:t3_route'
const HOSTILE = 'credential=TOPSECRET raw-body=PRIVATE title=HOSTILE'

const originalFetch = globalThis.fetch
const originalGet = redis.get.bind(redis)
const originalSet = redis.set.bind(redis)
const originalDel = redis.del.bind(redis)
const originalWatch = redis.watch.bind(redis)
const originalHSetNX = redis.hSetNX.bind(redis)
const originalHGet = redis.hGet.bind(redis)
const originalHDel = redis.hDel.bind(redis)
const originalHSet = redis.hSet.bind(redis)
const originalGetAppUser = reddit.getAppUser.bind(reddit)
const originalGetComments = reddit.getComments.bind(reddit)
const originalSubmitComment = reddit.submitComment.bind(reddit)
const originalConsoleInfo = console.info
const originalConsoleWarn = console.warn
const originalConsoleError = console.error

let server: Server
let serverURL: string
let comments: CommentCandidate[]
let listingHasMore: boolean
let calls: string[]
let logs: CapturedLog[]
let submitAttempts: number
let failFirstSubmit: boolean
let durableState: Map<string, string>
let leases: Map<string, LeaseRecord>
let versions: Map<string, number>
let promotionFaults: PromotionFault[]
let readFailures: number
let execFaults: ExecFault[]
let getCommentsOptions: Record<string, unknown>[]
let throwOnNextInfo: boolean

before(async () => {
  server = createServer(async (req, rsp) => {
    await runWithContext(
      {
        appName: 'rgeometrydash',
        postId: 't3_route',
        userId: 't2_author',
        username: 'author',
      } as unknown as Context,
      () => onReq(req, rsp),
    )
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const info = server.address() as AddressInfo
  serverURL = `http://127.0.0.1:${info.port}`
})

after(async () => {
  globalThis.fetch = originalFetch
  redis.get = originalGet
  redis.set = originalSet
  redis.del = originalDel
  redis.watch = originalWatch
  redis.hSetNX = originalHSetNX
  redis.hGet = originalHGet
  redis.hDel = originalHDel
  redis.hSet = originalHSet
  reddit.getAppUser = originalGetAppUser
  reddit.getComments = originalGetComments
  reddit.submitComment = originalSubmitComment
  console.info = originalConsoleInfo
  console.warn = originalConsoleWarn
  console.error = originalConsoleError
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
})

beforeEach(() => {
  comments = []
  listingHasMore = false
  calls = []
  logs = []
  submitAttempts = 0
  failFirstSubmit = false
  durableState = new Map()
  leases = new Map()
  versions = new Map()
  promotionFaults = []
  readFailures = 0
  execFaults = []
  getCommentsOptions = []
  throwOnNextInfo = false

  globalThis.fetch = async input => {
    calls.push('fetch')
    assert.equal(input, 'https://www.boomlings.com/database/getGJLevels21.php')
    return new Response(
      '1:12345678:2:Test Level:6:1:9:30:10:1000:14:50:15:3:18:6:11:0#1:Creator:2#',
    )
  }

  redis.get = (async key => {
    calls.push('get')
    if (readFailures > 0) {
      readFailures -= 1
      throw new Error(HOSTILE)
    }
    return liveLease(key)?.value
  }) as typeof redis.get

  redis.set = (async (key, value, options) => {
    calls.push('set')
    const current = liveLease(key)
    if (options?.nx && current) return 'OK'
    assert.ok(options?.expiration instanceof Date)
    leases.set(key, {value, expiration: options.expiration.getTime()})
    bump(key)
    return 'OK'
  }) as typeof redis.set

  redis.del = (async (...keys) => {
    calls.push('del')
    for (const key of keys) {
      if (leases.delete(key)) bump(key)
    }
  }) as typeof redis.del

  redis.hSetNX = (async (key, field, value) => {
    calls.push('hSetNX')
    const fault = value.startsWith('promotion:')
      ? promotionFaults.shift()
      : undefined
    if (fault?.when === 'before') throw new Error(HOSTILE)
    if (durableState.has(field)) return 0
    durableState.set(field, value)
    bump(key)
    if (fault?.when === 'after') {
      readFailures = fault.readFailuresAfter ?? 0
      throw new Error(HOSTILE)
    }
    return 1
  }) as typeof redis.hSetNX

  redis.hGet = (async (_key, field) => {
    calls.push('hGet')
    if (readFailures > 0) {
      readFailures -= 1
      throw new Error(HOSTILE)
    }
    return durableState.get(field)
  }) as typeof redis.hGet

  redis.hDel = (async (key, fields) => {
    calls.push('hDel')
    let deleted = 0
    for (const field of fields) {
      if (durableState.delete(field)) deleted += 1
    }
    if (deleted > 0) bump(key)
    return deleted
  }) as typeof redis.hDel

  redis.hSet = (async (key, values) => {
    calls.push('hSet')
    for (const [field, value] of Object.entries(values)) {
      durableState.set(field, value)
    }
    bump(key)
    return Object.keys(values).length
  }) as typeof redis.hSet

  redis.watch = (async (...keys) =>
    createTransaction(keys)) as typeof redis.watch

  reddit.getAppUser = async () =>
    ({username: 'rgeometrydash'}) as Awaited<
      ReturnType<typeof reddit.getAppUser>
    >
  reddit.getComments = ((options: Record<string, unknown>) => {
    calls.push('getComments')
    getCommentsOptions.push(options)
    const limit = typeof options.limit === 'number' ? options.limit : undefined
    const visible = limit === undefined ? comments : comments.slice(0, limit)
    return {
      all: async () => visible,
      get hasMore() {
        return listingHasMore
      },
    }
  }) as unknown as typeof reddit.getComments
  reddit.submitComment = (async (
    options: Parameters<typeof reddit.submitComment>[0],
  ) => {
    calls.push('submitComment')
    submitAttempts += 1
    assert.equal(options.runAs, 'APP')
    if (failFirstSubmit && submitAttempts === 1) {
      throw new Error(HOSTILE)
    }
    return {id: `t1_reply_${submitAttempts}`}
  }) as unknown as typeof reddit.submitComment

  console.info = (...values) => {
    if (throwOnNextInfo) {
      throwOnNextInfo = false
      throw new Error(HOSTILE)
    }
    logs.push({severity: 'info', text: values.join(' ')})
  }
  console.warn = (...values) =>
    logs.push({severity: 'warn', text: values.join(' ')})
  console.error = (...values) =>
    logs.push({severity: 'error', text: values.join(' ')})
})

test('rejects malformed trigger payloads before Redis or external effects', async () => {
  const invalidPayloads = [
    {},
    {...validPayload(), type: 'CommentSubmit'},
    {...validPayload(), post: {...validPayload().post, id: '123'}},
    {...validPayload(), post: {...validPayload().post, title: '   '}},
    {...validPayload(), post: {...validPayload().post, createdAt: null}},
    {...validPayload(), author: {id: 't2_author', name: '   '}},
  ]

  for (const payload of invalidPayloads) {
    const rsp = await postTrigger(payload)
    await assertInvalidResponse(rsp)
  }

  assert.deepEqual(calls, [])
  assertSafeLogs()
})

test('treats malformed raw JSON as generic warning-level validation with no side effects', async () => {
  const rsp = await postRaw(`${HOSTILE}{`)

  await assertInvalidResponse(rsp)
  assert.deepEqual(calls, [])
  assert.deepEqual(
    logs.map(log => log.severity),
    ['warn'],
  )
  assert.equal(eventNames().at(0), 'invalid_trigger_payload')
  assertSafeLogs()
})

test('claims with an expiring fresh owner before lookup and submits one app comment', async () => {
  const startedAt = Date.now()
  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.deepEqual(await rsp.json(), {})
  assert.equal(calls.indexOf('set') < calls.indexOf('fetch'), true)
  assert.equal(submitAttempts, 1)
  assert.match(durableState.get('t3_route') ?? '', /^confirmed:[0-9a-f-]{36}$/)
  assert.equal(leases.has(CLAIM_KEY), false)
  const firstLease = calls.indexOf('set')
  assert.notEqual(firstLease, -1)
  assert.equal(calls.slice(0, calls.indexOf('fetch')).includes('hSetNX'), false)
  assert.ok(
    observedExpirations.some(
      expiration =>
        expiration >= startedAt + 59_000 && expiration <= Date.now() + 61_000,
    ),
  )
})

test('exhaustive reconciliation finds an expected reply older than the first 100', async () => {
  failFirstSubmit = true
  comments = Array.from({length: 100}, (_, index) => ({
    authorName: 'other',
    body: `unrelated ${index}`,
    parentId: 't3_route',
  }))
  comments.push(expectedReply())

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 1)
  assert.deepEqual(getCommentsOptions, [
    {postId: 't3_route', pageSize: 100, sort: 'new'},
  ])
})

test('a saturated listing with unread data is inconclusive and never authorizes retry', async () => {
  failFirstSubmit = true
  comments = Array.from({length: 100}, (_, index) => ({
    authorName: 'other',
    body: `unrelated ${index}`,
    parentId: 't3_route',
  }))
  listingHasMore = true

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(durableState.get('t3_route')?.startsWith('unresolved:'), true)
  assert.deepEqual(getCommentsOptions, [
    {postId: 't3_route', pageSize: 100, sort: 'new'},
  ])
})

test('reconciliation still requires top-level app identity, level ID, and footer', async () => {
  failFirstSubmit = true
  comments = [
    {authorName: 'rgeometrydash', body: 'unrelated', parentId: 't3_route'},
    {authorName: 'other', body: '12345678', parentId: 't3_route'},
    {authorName: 'other', body: FOOTER_MARKER, parentId: 't3_route'},
    {
      authorName: 'rgeometrydash',
      body: `12345678 ${FOOTER_MARKER}`,
      parentId: 't1_parent',
    },
  ]

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 2)
})

test('promotion commit-then-throw resolves by exact owner readback and writes once', async () => {
  promotionFaults.push({when: 'after'})

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(durableState.get('t3_route')?.startsWith('confirmed:'), true)
  assert.equal(calls.filter(call => call === 'hSetNX').length, 1)
})

test('promotion throw-before-commit retries once after pre-submit readback', async () => {
  promotionFaults.push({when: 'before'})

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(calls.filter(call => call === 'hSetNX').length, 2)
})

test('a lost retry response is authorized only by the final exact readback', async () => {
  promotionFaults.push({when: 'before'}, {when: 'after'})

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(calls.filter(call => call === 'hSetNX').length, 2)
})

test('unresolved committed promotion writes nothing and recovers after lease expiry', async () => {
  promotionFaults.push({when: 'after', readFailuresAfter: 6})

  const first = await postTrigger(validPayload())

  assert.equal(first.status, 500)
  assert.equal(submitAttempts, 0)
  const promotion = durableState.get('t3_route')
  assert.match(promotion ?? '', /^promotion:[0-9a-f-]{36}$/)
  assert.match(leases.get(CLAIM_KEY)?.value ?? '', /^fresh:[0-9a-f-]{36}$/)

  expireLease('t3_route')
  calls = []
  logs = []
  const second = await postTrigger(validPayload())

  assert.equal(second.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(calls.indexOf('getComments') < calls.indexOf('fetch'), true)
  assert.equal(
    calls.indexOf('getComments') < calls.indexOf('submitComment'),
    true,
  )
  assert.equal(durableState.get('t3_route')?.startsWith('confirmed:'), true)
  assert.equal(leases.has(CLAIM_KEY), false)
})

test('two concurrent orphan deliveries grant one recovery owner and at most one write', async () => {
  durableState.set('t3_route', 'promotion:11111111-1111-4111-8111-111111111111')

  const [first, second] = await Promise.all([
    postTrigger(validPayload()),
    postTrigger(validPayload()),
  ])

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(calls.filter(call => call === 'getComments').length, 1)
  assert.equal(durableState.get('t3_route')?.startsWith('confirmed:'), true)
})

test('recovery that finds the prior reply confirms state without lookup or write', async () => {
  durableState.set('t3_route', 'promotion:11111111-1111-4111-8111-111111111111')
  comments = [expectedReply()]

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 200)
  assert.equal(submitAttempts, 0)
  assert.equal(calls.includes('fetch'), false)
  assert.equal(durableState.get('t3_route')?.startsWith('confirmed:'), true)
  assert.equal(calls.indexOf('getComments') < calls.indexOf('multi'), true)
})

test('inconclusive recovery preserves promotion for a later reconciliation attempt', async () => {
  durableState.set('t3_route', 'promotion:11111111-1111-4111-8111-111111111111')
  listingHasMore = true

  const first = await postTrigger(validPayload())

  assert.equal(first.status, 200)
  assert.equal(submitAttempts, 0)
  assert.equal(
    durableState.get('t3_route'),
    'promotion:11111111-1111-4111-8111-111111111111',
  )
  assert.equal(leases.has(CLAIM_KEY), false)

  listingHasMore = false
  const second = await postTrigger(validPayload())
  assert.equal(second.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(calls.filter(call => call === 'getComments').length, 2)
})

test('terminal durable states remain duplicate guards after every owner lease expires', async () => {
  for (const state of ['not-found', 'unresolved', 'confirmed']) {
    beforeEachTerminalState(`${state}:11111111-1111-4111-8111-111111111111`)
    const rsp = await postTrigger(validPayload())
    assert.equal(rsp.status, 200)
    assert.equal(submitAttempts, 0)
    assert.equal(calls.includes('set'), false)
    assert.equal(calls.includes('fetch'), false)
  }
})

test('persistent pre-submit release failure is recoverable after fresh lease expiry', async () => {
  globalThis.fetch = async () => {
    calls.push('fetch')
    throw new Error(HOSTILE)
  }
  execFaults.push('abort', 'abort', 'abort')

  const first = await postTrigger(validPayload())

  assert.equal(first.status, 500)
  assert.equal(durableState.has('t3_route'), false)
  assert.match(leases.get(CLAIM_KEY)?.value ?? '', /^fresh:[0-9a-f-]{36}$/)
  assert.equal(submitAttempts, 0)

  expireLease('t3_route')
  globalThis.fetch = async input => {
    calls.push('fetch')
    assert.equal(input, 'https://www.boomlings.com/database/getGJLevels21.php')
    return new Response(
      '1:12345678:2:Test Level:6:1:9:30:10:1000:14:50:15:3:18:6:11:0#1:Creator:2#',
    )
  }
  const second = await postTrigger(validPayload())

  assert.equal(second.status, 200)
  assert.equal(submitAttempts, 1)
  assert.equal(durableState.get('t3_route')?.startsWith('confirmed:'), true)
})

test('transaction abort during immediate authorization permits no comment write', async () => {
  execFaults.push('abort')

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 500)
  assert.equal(submitAttempts, 0)
  assert.equal(durableState.get('t3_route')?.startsWith('promotion:'), true)
})

test('classified retryable lookup failures produce one warning and no route error', async () => {
  globalThis.fetch = async () => {
    calls.push('fetch')
    throw new Error(HOSTILE)
  }

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 500)
  assert.deepEqual(logs.map(log => log.severity).slice(-1), ['warn'])
  assert.equal(eventNames().filter(name => name === 'request_failed').length, 0)
  assertSafeLogs()
})

test('unexpected route errors emit one fixed safe error with no hostile content', async () => {
  throwOnNextInfo = true

  const rsp = await postTrigger(validPayload())

  assert.equal(rsp.status, 500)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'internal server error',
    status: 500,
  })
  assert.deepEqual(
    logs.map(log => log.severity),
    ['error'],
  )
  assert.deepEqual(JSON.parse(logs[0]?.text ?? '{}'), {
    event: 'request_failed',
    stage: 'route',
    outcome: 'error',
    category: 'internal_error',
    summary: 'Unexpected route failure',
  })
  assertSafeLogs()
})

test('bootstrap error handler uses only fixed structured content without message or stack', async () => {
  const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url))
  const source = await readFile(indexPath, 'utf8')

  assert.equal(/\.stack\b|\.message\b/.test(source), false)
  assert.match(source, /server_error/)
  assert.match(source, /JSON\.stringify/)
})

test('manifest declares only the production trigger and least-privilege capabilities', async () => {
  const manifestPath = fileURLToPath(
    new URL('../../devvit.json', import.meta.url),
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >

  assert.deepEqual(manifest.permissions, {
    http: {enable: true, domains: ['www.boomlings.com']},
    reddit: true,
    redis: true,
  })
  assert.deepEqual(manifest.triggers, {
    onPostSubmit: `/${Endpoint.OnPostSubmit}`,
  })
  assert.equal('post' in manifest, false)
  assert.equal('menu' in manifest, false)
})

const observedExpirations: number[] = []

function liveLease(key: string): LeaseRecord | undefined {
  const lease = leases.get(key)
  if (!lease) return undefined
  observedExpirations.push(lease.expiration)
  if (lease.expiration > Date.now()) return lease
  leases.delete(key)
  bump(key)
  return undefined
}

function expireLease(postId: string): void {
  const key = `rgd-zbot:claim:${postId}`
  const lease = leases.get(key)
  assert.ok(lease)
  lease.expiration = 0
}

function bump(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1)
}

function createTransaction(
  keys: string[],
): Awaited<ReturnType<typeof redis.watch>> {
  calls.push('watch')
  const watched = new Map(keys.map(key => [key, versions.get(key) ?? 0]))
  const operations: Array<() => unknown> = []
  const transaction = {
    async multi() {
      calls.push('multi')
    },
    async hSet(key: string, values: Record<string, string>) {
      operations.push(() => {
        for (const [field, value] of Object.entries(values)) {
          durableState.set(field, value)
        }
        bump(key)
        return Object.keys(values).length
      })
      return transaction
    },
    async del(...keysToDelete: string[]) {
      operations.push(() => {
        for (const key of keysToDelete) {
          if (leases.delete(key)) bump(key)
        }
        return keysToDelete.length
      })
      return transaction
    },
    async set(
      key: string,
      value: string,
      options?: {readonly expiration?: Date},
    ) {
      operations.push(() => {
        assert.ok(options?.expiration)
        leases.set(key, {value, expiration: options.expiration.getTime()})
        bump(key)
        return 'OK'
      })
      return transaction
    },
    async exec() {
      calls.push('exec')
      const fault = execFaults.shift()
      if (fault === 'before') throw new Error(HOSTILE)
      if (
        [...watched].some(
          ([key, version]) => (versions.get(key) ?? 0) !== version,
        )
      ) {
        return []
      }
      if (fault === 'abort') return []
      const results = operations.map(operation => operation())
      if (fault === 'after') throw new Error(HOSTILE)
      return results
    },
    async unwatch() {
      calls.push('unwatch')
      return transaction
    },
    async discard() {
      calls.push('discard')
    },
  }
  return transaction as unknown as Awaited<ReturnType<typeof redis.watch>>
}

function expectedReply(): CommentCandidate {
  return {
    authorName: 'rgeometrydash',
    body: `Level 12345678 ${FOOTER_MARKER}`,
    parentId: 't3_route',
  }
}

function beforeEachTerminalState(state: string): void {
  durableState.clear()
  durableState.set('t3_route', state)
  leases.clear()
  calls = []
  logs = []
  submitAttempts = 0
}

function validPayload(): Record<string, unknown> & {
  readonly post: Record<string, unknown>
} {
  return {
    type: 'PostSubmit',
    post: {
      id: 't3_route',
      title: 'id: 12345678',
      authorId: 't2_author',
      createdAt: Date.now(),
    },
    author: {id: 't2_author', name: 'author'},
  }
}

async function postTrigger(payload: unknown): Promise<Response> {
  return postRaw(JSON.stringify(payload))
}

async function postRaw(body: string): Promise<Response> {
  return originalFetch(`${serverURL}/${Endpoint.OnPostSubmit}`, {
    body,
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })
}

async function assertInvalidResponse(rsp: Response): Promise<void> {
  assert.equal(rsp.status, 400)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'invalid trigger payload',
    status: 400,
  })
}

function eventNames(): string[] {
  return logs.map(log => {
    const event = JSON.parse(log.text) as {readonly event?: string}
    return event.event ?? ''
  })
}

function assertSafeLogs(): void {
  for (const log of logs) {
    assert.equal(log.text.includes(HOSTILE), false)
    const event = JSON.parse(log.text) as Record<string, unknown>
    assert.equal('title' in event, false)
    assert.equal('body' in event, false)
    assert.equal('headers' in event, false)
    assert.equal('stack' in event, false)
  }
}
