import assert from 'node:assert/strict'
import test from 'node:test'
import type {LevelInfo} from './boomlings.ts'
import {
  type ClaimLease,
  type ClaimState,
  type LifecycleEvent,
  type LogSeverity,
  type ProcessDependencies,
  type PromotionInspection,
  processPost,
} from './process-post.ts'

const NOW = 1_752_580_000_000
const LEASE_MS = 60_000
const LEVEL_ID = '10565740'
const POST_ID = 't3_level' as const
const LEVEL: LevelInfo = {
  id: LEVEL_ID,
  name: 'Bloodbath',
  description: 'A level description that must never enter logs',
  creatorUsername: 'Riot',
  difficulty: 'Extreme Demon',
  stars: 10,
  downloads: 1_000,
  likes: 500,
  length: 'Long',
  songName: 'At the Speed of Light',
  songArtist: 'Dimrain47',
  songId: 999_999,
  isOfficialSong: false,
}

type LogEntry = {readonly severity: LogSeverity; readonly event: LifecycleEvent}
type DurableState = {readonly state: ClaimState; readonly token: string}
type LiveLease = ClaimLease & {readonly expiresAt: number}

function post(overrides: Partial<Parameters<typeof processPost>[0]> = {}) {
  return {
    id: POST_ID,
    title: `My level ID: ${LEVEL_ID}`,
    authorName: 'player',
    createdAt: NOW,
    ...overrides,
  }
}

function harness(overrides: Partial<ProcessDependencies> = {}) {
  let clock = NOW
  let tokenNumber = 0
  let lease: LiveLease | undefined
  let durable: DurableState | undefined
  let lookupCount = 0
  let reconcileCount = 0
  let submitCount = 0
  let promoteCount = 0
  let inspectCount = 0
  let authorizeCount = 0
  const order: string[] = []
  const submitted: Array<{postId: string; text: string}> = []
  const logs: LogEntry[] = []

  const activeLease = (): LiveLease | undefined => {
    if (lease && lease.expiresAt <= clock) lease = undefined
    return lease
  }
  const nextToken = () => `token-${++tokenNumber}`
  const ownsLease = (candidate: ClaimLease): boolean => {
    const current = activeLease()
    return (
      current?.token === candidate.token &&
      current.kind === candidate.kind &&
      current.priorToken === candidate.priorToken
    )
  }
  const lineageMatches = (candidate: ClaimLease): boolean =>
    durable?.state === 'promotion' &&
    durable.token ===
      (candidate.kind === 'fresh' ? candidate.token : candidate.priorToken)

  const dependencies: ProcessDependencies = {
    now: () => clock,
    getAppUsername: async () => 'rgeometrydash',
    resumePromotion: async () => {
      const current = activeLease()
      if (!durable) return undefined
      if (durable.state !== 'promotion' || current) return 'blocked'
      const recovery: ClaimLease = {
        token: nextToken(),
        kind: 'promotion-recovery',
        priorToken: durable.token,
      }
      lease = {...recovery, expiresAt: clock + LEASE_MS}
      return recovery
    },
    claim: async () => {
      if (durable || activeLease()) return undefined
      const fresh: ClaimLease = {token: nextToken(), kind: 'fresh'}
      lease = {...fresh, expiresAt: clock + LEASE_MS}
      return fresh
    },
    release: async (_postId, candidate) => {
      if (ownsLease(candidate)) lease = undefined
    },
    retain: async (_postId, candidate, state) => {
      if (!ownsLease(candidate)) return false
      if (durable && !lineageMatches(candidate)) return false
      durable = {state, token: candidate.token}
      lease = undefined
      return true
    },
    inspectPromotion: async (_postId, candidate) => {
      inspectCount += 1
      if (!ownsLease(candidate)) return 'lost'
      if (lineageMatches(candidate)) return 'authorized'
      return candidate.kind === 'fresh' && !durable ? 'pre-submit' : 'lost'
    },
    promote: async (_postId, candidate) => {
      promoteCount += 1
      order.push('promote')
      if (!ownsLease(candidate)) return 'lost'
      if (candidate.kind === 'fresh') {
        if (!durable) durable = {state: 'promotion', token: candidate.token}
        return lineageMatches(candidate) ? 'authorized' : 'lost'
      }
      return lineageMatches(candidate) ? 'authorized' : 'lost'
    },
    authorizeWrite: async (_postId, candidate) => {
      authorizeCount += 1
      order.push('authorizeWrite')
      return ownsLease(candidate) && lineageMatches(candidate)
    },
    lookup: async () => {
      lookupCount += 1
      order.push('lookup')
      return LEVEL
    },
    format: level => {
      order.push('format')
      return `Level ${level.name}`
    },
    submitComment: async (postId, text) => {
      submitCount += 1
      order.push('submitComment')
      submitted.push({postId, text})
      return {id: `t1_reply_${submitCount}`}
    },
    reconcile: async () => {
      reconcileCount += 1
      order.push('reconcile')
      return 'inconclusive'
    },
    log: (severity, event) => logs.push({severity, event}),
    ...overrides,
  }

  return {
    dependencies,
    logs,
    order,
    submitted,
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
    authorizeCount: () => authorizeCount,
    durable: () => durable,
    inspectCount: () => inspectCount,
    lease: () => activeLease(),
    lookupCount: () => lookupCount,
    orphanPromotion: (token = 'orphan-token') => {
      durable = {state: 'promotion', token}
      lease = undefined
    },
    promoteCount: () => promoteCount,
    reconcileCount: () => reconcileCount,
    submitCount: () => submitCount,
  }
}

test('TRIG-01 and D-11 ignore no-ID titles before all I/O with no log event', async () => {
  const state = harness()
  const result = await processPost(
    post({title: 'Check out my level'}),
    state.dependencies,
  )
  assert.deepEqual(result, {status: 'ignored', reason: 'no-level-id'})
  assert.equal(state.lease(), undefined)
  assert.equal(state.lookupCount(), 0)
  assert.equal(state.submitCount(), 0)
  assert.deepEqual(state.logs, [])
})

test('TRIG-02 requires freshness and dynamic identity before a fresh claim', async () => {
  for (const createdAt of [NOW - 60_001, -1, Number.NaN]) {
    const state = harness()
    assert.deepEqual(await processPost(post({createdAt}), state.dependencies), {
      status: 'ignored',
      reason: 'stale',
    })
    assert.equal(state.lease(), undefined)
  }

  const self = harness({getAppUsername: async () => 'Dynamic-App'})
  assert.deepEqual(
    await processPost(post({authorName: 'dynamic-app'}), self.dependencies),
    {status: 'ignored', reason: 'self-authored'},
  )
  assert.equal(self.lease(), undefined)
})

test('D-01 timeout-category lookup rejection releases its lease for redelivery', async () => {
  let rejectLookup = true
  const state = harness({
    lookup: async () => {
      if (rejectLookup) throw new Error('credential=TIMEOUT_SECRET')
      return LEVEL
    },
  })

  await assert.rejects(processPost(post(), state.dependencies), error => {
    assert.equal((error as {category?: string}).category, 'lookup_failed')
    return true
  })
  assert.equal(state.lease(), undefined)
  assert.equal(state.logs.at(-1)?.severity, 'warn')
  assert.equal(state.logs.at(-1)?.event.category, 'lookup_failed')

  rejectLookup = false
  assert.equal(
    (await processPost(post(), state.dependencies)).status,
    'replied',
  )
  assert.equal(state.submitCount(), 1)
})

test('D-01 retries a transient token-checked release within the three-attempt bound', async () => {
  let releases = 0
  const state = harness({
    lookup: async () => {
      throw new Error('lookup source must not be logged')
    },
  })
  const originalRelease = state.dependencies.release
  state.dependencies.release = async (postId, lease) => {
    releases += 1
    if (releases < 3) throw new Error('redis source must not be logged')
    await originalRelease(postId, lease)
  }

  await assert.rejects(processPost(post(), state.dependencies))
  assert.equal(releases, 3)
  assert.equal(state.lease(), undefined)
  assert.equal(state.logs.at(-1)?.severity, 'warn')
  assert.equal(state.logs.at(-1)?.event.category, 'lookup_failed')
})

test('D-01 release exhaustion keeps an expiring lease and later redelivery can proceed', async () => {
  let failLookup = true
  let releases = 0
  const state = harness({
    lookup: async () => {
      if (failLookup) throw new Error('hostile lookup text')
      return LEVEL
    },
    release: async () => {
      releases += 1
      throw new Error('hostile redis text')
    },
  })

  await assert.rejects(processPost(post(), state.dependencies), error => {
    assert.equal((error as {category?: string}).category, 'release_failed')
    return true
  })
  assert.equal(releases, 3)
  assert.equal(state.logs.at(-1)?.severity, 'error')
  assert.equal(state.logs.at(-1)?.event.category, 'release_failed')
  assert.equal(state.submitCount(), 0)

  failLookup = false
  assert.deepEqual(await processPost(post(), state.dependencies), {
    status: 'ignored',
    reason: 'duplicate',
  })
  state.advance(LEASE_MS)
  assert.equal(
    (await processPost(post(), state.dependencies)).status,
    'replied',
  )
  assert.equal(state.submitCount(), 1)
})

test('promotion commit-then-throw resolves by exact readback and writes once', async () => {
  const state = harness()
  const promote = state.dependencies.promote
  let calls = 0
  state.dependencies.promote = async (postId, lease) => {
    calls += 1
    const result = await promote(postId, lease)
    if (calls === 1) throw new Error('lost promotion response')
    return result
  }

  const result = await processPost(post(), state.dependencies)
  assert.equal(result.status, 'replied')
  assert.equal(calls, 1)
  assert.equal(state.inspectCount(), 1)
  assert.equal(state.authorizeCount(), 1)
  assert.equal(state.submitCount(), 1)
})

test('promotion throw-before-commit retries once and exact readback authorizes one write', async () => {
  const state = harness()
  const promote = state.dependencies.promote
  let calls = 0
  state.dependencies.promote = async (postId, lease) => {
    calls += 1
    if (calls === 1) throw new Error('failed before commit')
    return promote(postId, lease)
  }

  assert.equal(
    (await processPost(post(), state.dependencies)).status,
    'replied',
  )
  assert.equal(calls, 2)
  assert.equal(state.inspectCount(), 2)
  assert.equal(state.submitCount(), 1)
})

test('a lost retry response is authorized only by the final exact readback', async () => {
  const state = harness()
  const promote = state.dependencies.promote
  let calls = 0
  state.dependencies.promote = async (postId, lease) => {
    calls += 1
    if (calls === 1) throw new Error('before commit')
    await promote(postId, lease)
    throw new Error('after commit')
  }

  assert.equal(
    (await processPost(post(), state.dependencies)).status,
    'replied',
  )
  assert.equal(calls, 2)
  assert.equal(state.inspectCount(), 2)
  assert.equal(state.submitCount(), 1)
})

test('final promotion uncertainty writes nothing and remains recoverable on redelivery', async () => {
  const state = harness()
  state.dependencies.reconcile = async () => {
    state.order.push('reconcile')
    return 'absent'
  }
  const promote = state.dependencies.promote
  let promotions = 0
  state.dependencies.promote = async (postId, lease) => {
    promotions += 1
    if (promotions === 1) await promote(postId, lease)
    throw new Error('unknown promotion outcome')
  }
  state.dependencies.inspectPromotion = async () => 'unknown'

  await assert.rejects(processPost(post(), state.dependencies), error => {
    assert.equal(
      (error as {category?: string}).category,
      'promotion_unresolved',
    )
    return true
  })
  assert.equal(promotions, 2)
  assert.equal(state.submitCount(), 0)
  assert.equal(state.durable()?.state, 'promotion')
  assert.equal(state.logs.at(-1)?.event.category, 'promotion_unresolved')

  state.advance(LEASE_MS + 1)
  state.dependencies.promote = promote
  state.dependencies.inspectPromotion = async (postId, lease) => {
    return harnessInspection(state, postId, lease)
  }
  assert.equal(
    (await processPost(post(), state.dependencies)).status,
    'replied',
  )
  assert.deepEqual(state.order.slice(-6), [
    'reconcile',
    'lookup',
    'format',
    'promote',
    'authorizeWrite',
    'submitComment',
  ])
  assert.equal(state.submitCount(), 1)
})

test('recovery found confirms without lookup, while inconclusive recovery stays recoverable', async () => {
  const found = orphanedPromotionHarness('found')
  assert.deepEqual(await processPost(post(), found.dependencies), {
    status: 'ignored',
    reason: 'unresolved',
  })
  assert.equal(
    found.order.filter(operation => operation === 'reconcile').length,
    1,
  )
  assert.equal(found.lookupCount(), 0)
  assert.equal(found.submitCount(), 0)
  assert.equal(found.durable()?.state, 'confirmed')

  const inconclusive = orphanedPromotionHarness('inconclusive')
  assert.deepEqual(await processPost(post(), inconclusive.dependencies), {
    status: 'ignored',
    reason: 'unresolved',
  })
  assert.equal(inconclusive.lookupCount(), 0)
  assert.equal(inconclusive.lease(), undefined)
  assert.equal(inconclusive.durable()?.state, 'promotion')
  await processPost(post(), inconclusive.dependencies)
  assert.equal(
    inconclusive.order.filter(operation => operation === 'reconcile').length,
    2,
  )
})

test('two concurrent recovery deliveries acquire one owner and make at most one write', async () => {
  let unblock: (() => void) | undefined
  const barrier = new Promise<void>(resolve => {
    unblock = resolve
  })
  const state = orphanedPromotionHarness('absent', {
    reconcile: async () => {
      state.order.push('reconcile')
      await barrier
      return 'absent'
    },
  })

  const first = processPost(post(), state.dependencies)
  await Promise.resolve()
  const second = await processPost(post(), state.dependencies)
  assert.deepEqual(second, {status: 'ignored', reason: 'duplicate'})
  unblock?.()
  assert.equal((await first).status, 'replied')
  assert.equal(state.submitCount(), 1)
  assert.equal(state.authorizeCount(), 1)
})

test('loss of the live owner before authorizeWrite makes zero comment calls', async () => {
  const state = harness()
  state.dependencies.authorizeWrite = async (_postId, lease) => {
    await state.dependencies.release(POST_ID, lease)
    return false
  }

  await assert.rejects(processPost(post(), state.dependencies), error => {
    assert.equal(
      (error as {category?: string}).category,
      'claim_ownership_lost',
    )
    return true
  })
  assert.equal(state.submitCount(), 0)
})

test('D-02 through D-04 guard both writes and retain unresolved after one failed retry', async () => {
  let attempts = 0
  let reconciliations = 0
  const state = harness({
    reconcile: async () => {
      reconciliations += 1
      return 'absent'
    },
    submitComment: async () => {
      attempts += 1
      throw new Error(`ambiguous ${attempts}`)
    },
  })

  assert.deepEqual(await processPost(post(), state.dependencies), {
    status: 'ignored',
    reason: 'unresolved',
  })
  assert.equal(attempts, 2)
  assert.equal(state.authorizeCount(), 2)
  assert.equal(reconciliations, 1)
  assert.equal(state.durable()?.state, 'unresolved')
})

test('D-02/D-03 reconcile one ambiguous write and confirm a found reply without retry', async () => {
  let attempts = 0
  let reconciliations = 0
  const state = harness({
    reconcile: async () => {
      reconciliations += 1
      return 'found'
    },
    submitComment: async () => {
      attempts += 1
      throw new Error('ambiguous')
    },
  })

  assert.deepEqual(await processPost(post(), state.dependencies), {
    status: 'ignored',
    reason: 'unresolved',
  })
  assert.equal(attempts, 1)
  assert.equal(reconciliations, 1)
  assert.equal(state.authorizeCount(), 1)
  assert.equal(state.durable()?.state, 'confirmed')
})

test('D-04 retains unresolved after an inconclusive or failed comment read', async () => {
  for (const reconcile of [
    async () => 'inconclusive' as const,
    async () => {
      throw new Error('hostile comment body')
    },
  ]) {
    let attempts = 0
    const state = harness({
      reconcile,
      submitComment: async () => {
        attempts += 1
        throw new Error('ambiguous')
      },
    })
    assert.deepEqual(await processPost(post(), state.dependencies), {
      status: 'ignored',
      reason: 'unresolved',
    })
    assert.equal(attempts, 1)
    assert.equal(state.authorizeCount(), 1)
    assert.equal(state.durable()?.state, 'unresolved')
    assert.equal(state.logs.at(-1)?.event.category, 'reconcile_inconclusive')
  }
})

test('D-04 retries once after definitive absence and confirms the successful retry', async () => {
  let attempts = 0
  const state = harness({
    reconcile: async () => 'absent',
    submitComment: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('ambiguous')
      return {id: 't1_retry'}
    },
  })

  assert.deepEqual(await processPost(post(), state.dependencies), {
    status: 'replied',
    levelId: LEVEL_ID,
    commentId: 't1_retry',
  })
  assert.equal(attempts, 2)
  assert.equal(state.authorizeCount(), 2)
  assert.equal(state.durable()?.state, 'confirmed')
})

test('D-12 through D-14 use fixed summaries and classify each failure exactly once', async () => {
  const hostile = [
    'credential=TOP_SECRET',
    'title=private title',
    'description=private description',
    'raw response body',
    'stack at private.ts:1',
  ].join(' | ')
  const state = harness({
    lookup: async () => {
      throw new Error(hostile)
    },
  })

  await assert.rejects(processPost(post(), state.dependencies))
  const serialized = JSON.stringify(state.logs)
  for (const fragment of [
    'TOP_SECRET',
    'private title',
    'private description',
    'raw response body',
    'private.ts',
  ])
    assert.equal(serialized.includes(fragment), false, fragment)

  const failureEvents = state.logs.filter(
    entry =>
      entry.event.event === 'processing_failed' ||
      entry.event.event === 'processing_abandoned',
  )
  assert.equal(failureEvents.length, 1)
  assert.equal(failureEvents[0]?.severity, 'warn')
  assert.equal(failureEvents[0]?.event.category, 'lookup_failed')
  assert.equal(failureEvents[0]?.event.summary, 'Level lookup failed')
})

function orphanedPromotionHarness(
  reconciliation: 'found' | 'absent' | 'inconclusive',
  overrides: Partial<ProcessDependencies> = {},
) {
  const state = harness(overrides)
  state.orphanPromotion()
  if (!overrides.reconcile) {
    state.dependencies.reconcile = async () => {
      state.order.push('reconcile')
      return reconciliation
    }
  }
  return state
}

async function harnessInspection(
  state: ReturnType<typeof harness>,
  postId: Parameters<ProcessDependencies['inspectPromotion']>[0],
  lease: Parameters<ProcessDependencies['inspectPromotion']>[1],
): Promise<PromotionInspection> {
  const current = state.lease()
  const durable = state.durable()
  if (
    current?.token !== lease.token ||
    current.kind !== lease.kind ||
    current.priorToken !== lease.priorToken
  )
    return 'lost'
  const lineage = lease.kind === 'fresh' ? lease.token : lease.priorToken
  if (durable?.state === 'promotion' && durable.token === lineage)
    return 'authorized'
  if (!durable && lease.kind === 'fresh') return 'pre-submit'
  void postId
  return 'lost'
}
