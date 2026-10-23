import {findLevelId} from '../shared/level-id.ts'
import type {LevelInfo} from './boomlings.ts'

export type PostId = `t3_${string}`

export type PostInput = {
  readonly id: PostId
  readonly title: string
  readonly authorName: string
  readonly createdAt: number
}

export type ClaimLease = {
  readonly token: string
  readonly kind: 'fresh' | 'promotion-recovery'
  readonly priorToken?: string
}

export type ClaimState = 'promotion' | 'not-found' | 'unresolved' | 'confirmed'

export type PromotionInspection =
  | 'authorized'
  | 'pre-submit'
  | 'lost'
  | 'unknown'

export type ReconciliationResult = 'found' | 'absent' | 'inconclusive'
export type LogSeverity = 'info' | 'warn' | 'error'

export type ProcessErrorCategory =
  | 'identity_unavailable'
  | 'claim_failed'
  | 'release_failed'
  | 'lookup_failed'
  | 'format_failed'
  | 'claim_ownership_lost'
  | 'promotion_failed'
  | 'promotion_unresolved'
  | 'submit_ambiguous'
  | 'reconcile_inconclusive'
  | 'retry_ambiguous'
  | 'moderation_failed'

export type LifecycleEvent = {
  readonly event:
    | 'post_qualified'
    | 'claim_acquired'
    | 'claim_duplicate'
    | 'lookup_found'
    | 'lookup_not_found'
    | 'reply_created'
    | 'submit_ambiguous'
    | 'reconciliation_found'
    | 'reconciliation_absent'
    | 'reply_retried'
    | 'moderation_retrying'
    | 'moderation_succeeded'
    | 'moderation_failed'
    | 'processing_failed'
    | 'processing_abandoned'
  readonly postId?: PostId
  readonly levelId?: string
  readonly commentId?: string
  readonly stage?: string
  readonly outcome?: string
  readonly category?: ProcessErrorCategory
  readonly summary?: string
}

export type ProcessResult =
  | {
      readonly status: 'ignored'
      readonly reason:
        | 'no-level-id'
        | 'stale'
        | 'self-authored'
        | 'duplicate'
        | 'not-found'
        | 'unresolved'
    }
  | {
      readonly status: 'replied'
      readonly levelId: string
      readonly commentId: string
    }

type SubmittedComment = {
  readonly id: string
  distinguishAndSticky(): Promise<void>
}

export type ProcessDependencies = {
  now(): number
  getAppUsername(): Promise<string | undefined>
  resumePromotion(postId: PostId): Promise<ClaimLease | 'blocked' | undefined>
  claim(postId: PostId): Promise<ClaimLease | undefined>
  release(postId: PostId, lease: ClaimLease): Promise<void>
  retain(
    postId: PostId,
    lease: ClaimLease,
    state: Exclude<ClaimState, 'promotion'>,
  ): Promise<boolean>
  promote(postId: PostId, lease: ClaimLease): Promise<'authorized' | 'lost'>
  inspectPromotion(
    postId: PostId,
    lease: ClaimLease,
  ): Promise<PromotionInspection>
  authorizeWrite(postId: PostId, lease: ClaimLease): Promise<boolean>
  lookup(levelId: string): Promise<LevelInfo | null>
  format(level: LevelInfo): string
  submitComment(postId: PostId, text: string): Promise<SubmittedComment>
  reconcile(postId: PostId, levelId: string): Promise<ReconciliationResult>
  log(severity: LogSeverity, event: LifecycleEvent): void
}

const SAFE_SUMMARIES = {
  identity_unavailable: 'App identity unavailable',
  claim_failed: 'Post claim failed',
  release_failed: 'Post lease release failed',
  lookup_failed: 'Level lookup failed',
  format_failed: 'Reply formatting failed',
  claim_ownership_lost: 'Post lease ownership lost',
  promotion_failed: 'Comment authorization failed',
  promotion_unresolved: 'Comment authorization outcome is unresolved',
  submit_ambiguous: 'Comment submission outcome is uncertain',
  reconcile_inconclusive: 'Comment reconciliation was inconclusive',
  retry_ambiguous: 'Comment retry outcome is uncertain',
  moderation_failed: 'Comment moderation failed',
} as const satisfies Record<ProcessErrorCategory, string>

export class ProcessPostError extends Error {
  readonly category: ProcessErrorCategory

  constructor(category: ProcessErrorCategory, cause?: unknown) {
    super(SAFE_SUMMARIES[category], {cause})
    this.name = 'ProcessPostError'
    this.category = category
  }
}

const MAX_AGE_MS = 60_000
const SECONDS_THRESHOLD = 10_000_000_000
const RELEASE_ATTEMPTS = 3

export async function processPost(
  post: PostInput,
  dependencies: ProcessDependencies,
): Promise<ProcessResult> {
  const levelId = findLevelId(post.title)
  if (!levelId) return {status: 'ignored', reason: 'no-level-id'}

  const recovery = await resumePromotion(dependencies, post.id, levelId)
  if (recovery === 'blocked') {
    log(dependencies, 'info', {
      event: 'claim_duplicate',
      postId: post.id,
      levelId,
      stage: 'promotion-recovery',
      outcome: 'blocked',
    })
    return {status: 'ignored', reason: 'duplicate'}
  }

  let lease: ClaimLease
  if (recovery) {
    lease = recovery
    log(dependencies, 'info', {
      event: 'claim_acquired',
      postId: post.id,
      levelId,
      stage: 'promotion-recovery',
      outcome: 'acquired',
    })
    const recoveryResult = await reconcileRecovery(
      dependencies,
      post.id,
      levelId,
      lease,
    )
    if (recoveryResult) return recoveryResult
  } else {
    const filterResult = await filterFreshPost(dependencies, post, levelId)
    if (filterResult) return filterResult

    log(dependencies, 'info', {
      event: 'post_qualified',
      postId: post.id,
      levelId,
      stage: 'filter',
      outcome: 'qualified',
    })

    const claimedLease = await claimFresh(dependencies, post.id, levelId)
    if (!claimedLease) {
      log(dependencies, 'info', {
        event: 'claim_duplicate',
        postId: post.id,
        levelId,
        stage: 'claim',
        outcome: 'duplicate',
      })
      return {status: 'ignored', reason: 'duplicate'}
    }
    lease = claimedLease
    log(dependencies, 'info', {
      event: 'claim_acquired',
      postId: post.id,
      levelId,
      stage: 'claim',
      outcome: 'acquired',
    })
  }

  let level: LevelInfo | null
  try {
    level = await dependencies.lookup(levelId)
  } catch (error) {
    return releaseBeforeSubmit(
      dependencies,
      post.id,
      levelId,
      lease,
      'lookup',
      'lookup_failed',
      error,
    )
  }

  if (!level) {
    await retainOrThrow(
      dependencies,
      post.id,
      levelId,
      lease,
      'not-found',
      'lookup',
    )
    log(dependencies, 'info', {
      event: 'lookup_not_found',
      postId: post.id,
      levelId,
      stage: 'lookup',
      outcome: 'not-found',
    })
    return {status: 'ignored', reason: 'not-found'}
  }
  log(dependencies, 'info', {
    event: 'lookup_found',
    postId: post.id,
    levelId,
    stage: 'lookup',
    outcome: 'found',
  })

  let text: string
  try {
    text = dependencies.format(level)
  } catch (error) {
    return releaseBeforeSubmit(
      dependencies,
      post.id,
      levelId,
      lease,
      'format',
      'format_failed',
      error,
    )
  }

  const promotion = await resolvePromotion(dependencies, post.id, lease)
  if (promotion !== 'authorized') {
    const category =
      promotion === 'lost' ? 'promotion_failed' : 'promotion_unresolved'
    fail(dependencies, post.id, levelId, 'promotion', category)
  }

  await authorizeWrite(dependencies, post.id, levelId, lease, 'submit')
  let comment: SubmittedComment
  try {
    comment = await dependencies.submitComment(post.id, text)
  } catch (error) {
    if (error instanceof ProcessPostError) throw error
    return reconcileAmbiguousSubmit(post.id, levelId, text, lease, dependencies)
  }
  await retainOrThrow(
    dependencies,
    post.id,
    levelId,
    lease,
    'confirmed',
    'submit',
  )
  log(dependencies, 'info', {
    event: 'reply_created',
    postId: post.id,
    levelId,
    commentId: comment.id,
    stage: 'submit',
    outcome: 'replied',
  })
  await moderateSubmittedComment(dependencies, post.id, levelId, comment)
  return {status: 'replied', levelId, commentId: comment.id}
}

function normalizeTimestamp(createdAt: number): number | undefined {
  if (!Number.isFinite(createdAt) || createdAt < 0) return undefined
  return createdAt < SECONDS_THRESHOLD ? createdAt * 1_000 : createdAt
}

async function resumePromotion(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
): Promise<ClaimLease | 'blocked' | undefined> {
  try {
    return await dependencies.resumePromotion(postId)
  } catch (error) {
    warnAndThrow(
      dependencies,
      postId,
      levelId,
      'promotion-recovery',
      'claim_failed',
      error,
    )
  }
}

async function filterFreshPost(
  dependencies: ProcessDependencies,
  post: PostInput,
  levelId: string,
): Promise<ProcessResult | undefined> {
  const createdAtMs = normalizeTimestamp(post.createdAt)
  const now = dependencies.now()
  if (
    createdAtMs === undefined ||
    !Number.isFinite(now) ||
    now < 0 ||
    now - createdAtMs > MAX_AGE_MS
  ) {
    log(dependencies, 'info', {
      event: 'post_qualified',
      postId: post.id,
      levelId,
      stage: 'filter',
      outcome: 'stale',
    })
    return {status: 'ignored', reason: 'stale'}
  }

  let appUsername: string | undefined
  try {
    appUsername = await dependencies.getAppUsername()
  } catch {
    logAbandoned(
      dependencies,
      post.id,
      levelId,
      'identity',
      'identity_unavailable',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }
  if (!appUsername) {
    logAbandoned(
      dependencies,
      post.id,
      levelId,
      'identity',
      'identity_unavailable',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }
  if (
    appUsername.localeCompare(post.authorName, undefined, {
      sensitivity: 'accent',
    }) === 0
  ) {
    log(dependencies, 'info', {
      event: 'post_qualified',
      postId: post.id,
      levelId,
      stage: 'filter',
      outcome: 'self-authored',
    })
    return {status: 'ignored', reason: 'self-authored'}
  }
  return undefined
}

async function claimFresh(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
): Promise<ClaimLease | undefined> {
  try {
    return await dependencies.claim(postId)
  } catch (error) {
    warnAndThrow(dependencies, postId, levelId, 'claim', 'claim_failed', error)
  }
}

async function reconcileRecovery(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  lease: ClaimLease,
): Promise<ProcessResult | undefined> {
  let reconciliation: ReconciliationResult
  try {
    reconciliation = await dependencies.reconcile(postId, levelId)
  } catch {
    await relinquishRecovery(dependencies, postId, lease)
    logAbandoned(
      dependencies,
      postId,
      levelId,
      'promotion-recovery',
      'reconcile_inconclusive',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }

  if (reconciliation === 'found') {
    await retainOrThrow(
      dependencies,
      postId,
      levelId,
      lease,
      'confirmed',
      'promotion-recovery',
    )
    log(dependencies, 'info', {
      event: 'reconciliation_found',
      postId,
      levelId,
      stage: 'promotion-recovery',
      outcome: 'reply-found',
    })
    return {status: 'ignored', reason: 'unresolved'}
  }
  if (reconciliation === 'inconclusive') {
    await relinquishRecovery(dependencies, postId, lease)
    logAbandoned(
      dependencies,
      postId,
      levelId,
      'promotion-recovery',
      'reconcile_inconclusive',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }

  log(dependencies, 'warn', {
    event: 'reconciliation_absent',
    postId,
    levelId,
    stage: 'promotion-recovery',
    outcome: 'continuing',
  })
  return undefined
}

async function relinquishRecovery(
  dependencies: ProcessDependencies,
  postId: PostId,
  lease: ClaimLease,
): Promise<void> {
  try {
    await dependencies.release(postId, lease)
  } catch {
    // The owner lease is expiring; preserving the promotion record is fail-safe.
  }
}

async function releaseBeforeSubmit(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  lease: ClaimLease,
  stage: 'lookup' | 'format',
  category: 'lookup_failed' | 'format_failed',
  cause: unknown,
): Promise<never> {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    let released = false
    try {
      await dependencies.release(postId, lease)
      released = true
    } catch {
      // Retry only within the fixed bound; the lease expiry is the final fallback.
    }
    if (released) {
      log(dependencies, 'warn', {
        event: 'processing_failed',
        postId,
        levelId,
        stage,
        outcome: 'released',
        category,
        summary: SAFE_SUMMARIES[category],
      })
      throw new ProcessPostError(category, cause)
    }
  }

  logAbandoned(dependencies, postId, levelId, 'release', 'release_failed')
  throw new ProcessPostError('release_failed', cause)
}

async function resolvePromotion(
  dependencies: ProcessDependencies,
  postId: PostId,
  lease: ClaimLease,
): Promise<'authorized' | 'lost' | 'unknown'> {
  try {
    const result = await dependencies.promote(postId, lease)
    if (result === 'authorized') return 'authorized'
    return 'lost'
  } catch {
    // A lost response is resolved only by exact durable readback.
  }

  const firstInspection = await inspectPromotion(dependencies, postId, lease)
  if (firstInspection === 'authorized') return 'authorized'
  if (firstInspection === 'lost') return 'lost'

  let retryResult: 'authorized' | 'lost' | 'unknown' = 'unknown'
  try {
    retryResult = await dependencies.promote(postId, lease)
  } catch {
    // The mandatory final readback decides a lost retry response.
  }

  const finalInspection = await inspectPromotion(dependencies, postId, lease)
  if (retryResult === 'authorized' || finalInspection === 'authorized')
    return 'authorized'
  if (retryResult === 'lost' || finalInspection === 'lost') return 'lost'
  return 'unknown'
}

async function inspectPromotion(
  dependencies: ProcessDependencies,
  postId: PostId,
  lease: ClaimLease,
): Promise<PromotionInspection> {
  try {
    return await dependencies.inspectPromotion(postId, lease)
  } catch {
    return 'unknown'
  }
}

async function authorizeWrite(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  lease: ClaimLease,
  stage: 'submit' | 'retry',
): Promise<void> {
  try {
    if (await dependencies.authorizeWrite(postId, lease)) return
  } catch {
    // Throwing authorization checks fail closed like an explicit false result.
  }
  fail(dependencies, postId, levelId, stage, 'claim_ownership_lost')
}

async function reconcileAmbiguousSubmit(
  postId: PostId,
  levelId: string,
  text: string,
  lease: ClaimLease,
  dependencies: ProcessDependencies,
): Promise<ProcessResult> {
  log(dependencies, 'warn', {
    event: 'submit_ambiguous',
    postId,
    levelId,
    stage: 'submit',
    outcome: 'unresolved',
    category: 'submit_ambiguous',
    summary: SAFE_SUMMARIES.submit_ambiguous,
  })

  let reconciliation: ReconciliationResult
  try {
    reconciliation = await dependencies.reconcile(postId, levelId)
  } catch {
    await retainAfterAmbiguous(
      dependencies,
      postId,
      levelId,
      lease,
      'reconcile',
      'reconcile_inconclusive',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }

  if (reconciliation === 'found') {
    await retainOrThrow(
      dependencies,
      postId,
      levelId,
      lease,
      'confirmed',
      'reconcile',
    )
    log(dependencies, 'info', {
      event: 'reconciliation_found',
      postId,
      levelId,
      stage: 'reconcile',
      outcome: 'reply-found',
    })
    return {status: 'ignored', reason: 'unresolved'}
  }

  if (reconciliation === 'inconclusive') {
    await retainAfterAmbiguous(
      dependencies,
      postId,
      levelId,
      lease,
      'reconcile',
      'reconcile_inconclusive',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }

  log(dependencies, 'warn', {
    event: 'reconciliation_absent',
    postId,
    levelId,
    stage: 'reconcile',
    outcome: 'retrying',
  })
  await authorizeWrite(dependencies, postId, levelId, lease, 'retry')
  let comment: SubmittedComment
  try {
    comment = await dependencies.submitComment(postId, text)
  } catch (error) {
    if (error instanceof ProcessPostError) throw error
    await retainAfterAmbiguous(
      dependencies,
      postId,
      levelId,
      lease,
      'retry',
      'retry_ambiguous',
    )
    return {status: 'ignored', reason: 'unresolved'}
  }
  await retainOrThrow(
    dependencies,
    postId,
    levelId,
    lease,
    'confirmed',
    'retry',
  )
  log(dependencies, 'info', {
    event: 'reply_retried',
    postId,
    levelId,
    commentId: comment.id,
    stage: 'retry',
    outcome: 'replied',
  })
  await moderateSubmittedComment(dependencies, postId, levelId, comment)
  return {status: 'replied', levelId, commentId: comment.id}
}

async function moderateSubmittedComment(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  comment: SubmittedComment,
): Promise<void> {
  try {
    await comment.distinguishAndSticky()
  } catch {
    log(dependencies, 'warn', {
      event: 'moderation_retrying',
      postId,
      levelId,
      commentId: comment.id,
      stage: 'moderation',
      outcome: 'retrying',
    })
    try {
      await comment.distinguishAndSticky()
    } catch {
      log(dependencies, 'error', {
        event: 'moderation_failed',
        postId,
        levelId,
        commentId: comment.id,
        stage: 'moderation',
        outcome: 'failed',
        category: 'moderation_failed',
        summary: SAFE_SUMMARIES.moderation_failed,
      })
      return
    }
  }

  log(dependencies, 'info', {
    event: 'moderation_succeeded',
    postId,
    levelId,
    commentId: comment.id,
    stage: 'moderation',
    outcome: 'succeeded',
  })
}

async function retainAfterAmbiguous(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  lease: ClaimLease,
  stage: 'reconcile' | 'retry',
  category: 'reconcile_inconclusive' | 'retry_ambiguous',
): Promise<void> {
  try {
    const retained = await dependencies.retain(postId, lease, 'unresolved')
    if (!retained) throw new ProcessPostError('claim_ownership_lost')
  } catch (error) {
    if (error instanceof ProcessPostError) {
      logAbandoned(dependencies, postId, levelId, stage, error.category)
      throw error
    }
    fail(dependencies, postId, levelId, stage, 'claim_ownership_lost', error)
  }
  logAbandoned(dependencies, postId, levelId, stage, category)
}

async function retainOrThrow(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  lease: ClaimLease,
  state: Exclude<ClaimState, 'promotion'>,
  stage: string,
): Promise<void> {
  try {
    if (await dependencies.retain(postId, lease, state)) return
  } catch (error) {
    fail(dependencies, postId, levelId, stage, 'claim_ownership_lost', error)
  }
  fail(dependencies, postId, levelId, stage, 'claim_ownership_lost')
}

function warnAndThrow(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  stage: string,
  category: 'claim_failed',
  cause: unknown,
): never {
  log(dependencies, 'warn', {
    event: 'processing_failed',
    postId,
    levelId,
    stage,
    outcome: 'retryable',
    category,
    summary: SAFE_SUMMARIES[category],
  })
  throw new ProcessPostError(category, cause)
}

function fail(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  stage: string,
  category:
    | 'claim_ownership_lost'
    | 'promotion_failed'
    | 'promotion_unresolved',
  cause?: unknown,
): never {
  logAbandoned(dependencies, postId, levelId, stage, category)
  throw new ProcessPostError(category, cause)
}

function logAbandoned(
  dependencies: ProcessDependencies,
  postId: PostId,
  levelId: string,
  stage: string,
  category: ProcessErrorCategory,
): void {
  log(dependencies, 'error', {
    event: 'processing_abandoned',
    postId,
    levelId,
    stage,
    outcome: 'unresolved',
    category,
    summary: SAFE_SUMMARIES[category],
  })
}

function log(
  dependencies: ProcessDependencies,
  severity: LogSeverity,
  event: LifecycleEvent,
): void {
  dependencies.log(severity, event)
}
