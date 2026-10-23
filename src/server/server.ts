import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {reddit, redis} from '@devvit/web/server'
import type {
  OnPostSubmitRequest,
  PartialJsonValue,
  TriggerResponse,
} from '@devvit/web/shared'
import {Endpoint, EndpointMethod, type ErrorRsp} from '../shared/api.ts'
import {lookupLevel} from './boomlings.ts'
import {FOOTER_MARKER, formatReply} from './format-reply.ts'
import {
  type ClaimLease,
  type LifecycleEvent,
  type LogSeverity,
  type PostId,
  type ProcessDependencies,
  ProcessPostError,
  processPost,
  type ReconciliationResult,
} from './process-post.ts'

const PROCESSED_POSTS_KEY = 'rgd-zbot:processed-posts'
const CLAIM_LEASE_MS = 60_000

type AnyRsp = TriggerResponse | ErrorRsp

type ValidOnPostSubmitRequest = OnPostSubmitRequest & {
  readonly post: {
    readonly id: PostId
    readonly title: string
    readonly createdAt: number
  }
  readonly author: {
    readonly name: string
  }
}

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (error) {
    if (!(error instanceof ProcessPostError)) {
      emitLifecycleEvent('error', {
        event: 'request_failed',
        stage: 'route',
        outcome: 'error',
        category: 'internal_error',
        summary: 'Unexpected route failure',
      })
    }
    writeJson<ErrorRsp>(
      500,
      {error: 'internal server error', status: 500},
      rspMsg,
    )
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.OnPostSubmit:
        try {
          rsp = await routeOnPostSubmit(await readJson<unknown>(reqMsg))
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          rsp = invalidTriggerPayload()
        }
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function routeOnPostSubmit(input: unknown): Promise<AnyRsp> {
  if (!isOnPostSubmitRequest(input)) {
    return invalidTriggerPayload()
  }

  await processPost(
    {
      id: input.post.id,
      title: input.post.title,
      authorName: input.author.name,
      createdAt: input.post.createdAt,
    },
    createProcessDependencies(),
  )
  return {}
}

function createProcessDependencies(): ProcessDependencies {
  return {
    now: Date.now,
    getAppUsername: async () => (await reddit.getAppUser())?.username,
    resumePromotion: async postId => {
      const state = await redis.hGet(PROCESSED_POSTS_KEY, postId)
      if (state === undefined) return undefined
      const priorToken = promotionTokenFromState(state)
      if (!priorToken) return 'blocked'

      const key = claimKey(postId)
      if ((await redis.get(key)) !== undefined) return 'blocked'

      const lease: ClaimLease = {
        token: randomUUID(),
        kind: 'promotion-recovery',
        priorToken,
      }
      const owner = leaseValue(lease)
      await redis.set(key, owner, {
        nx: true,
        expiration: leaseExpiration(),
      })
      const [observedState, observedOwner] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      if (observedState === state && observedOwner === owner) return lease
      await deleteLeaseIfOwner(postId, owner)
      return 'blocked'
    },
    claim: async postId => {
      if ((await redis.hGet(PROCESSED_POSTS_KEY, postId)) !== undefined)
        return undefined
      const lease: ClaimLease = {token: randomUUID(), kind: 'fresh'}
      const key = claimKey(postId)
      const owner = leaseValue(lease)
      await redis.set(key, owner, {
        nx: true,
        expiration: leaseExpiration(),
      })
      const [state, observedOwner] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      if (state === undefined && observedOwner === owner) return lease
      await deleteLeaseIfOwner(postId, owner)
      return undefined
    },
    release: async (postId, lease) => {
      const key = claimKey(postId)
      const owner = leaseValue(lease)
      const transaction = await redis.watch(PROCESSED_POSTS_KEY, key)
      const [state, observedOwner] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      if (observedOwner !== owner || !leaseMayOwnState(lease, state)) {
        await transaction.unwatch()
        return
      }
      await transaction.multi()
      await transaction.del(key)
      const result = await transaction.exec()
      if (result.length === 0) throw new Error('Post lease release aborted')
    },
    retain: async (postId, lease, state) => {
      const key = claimKey(postId)
      const owner = leaseValue(lease)
      const transaction = await redis.watch(PROCESSED_POSTS_KEY, key)
      const [current, observedOwner] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      if (observedOwner !== owner || !leaseMayOwnState(lease, current)) {
        await transaction.unwatch()
        return false
      }
      await transaction.multi()
      await transaction.hSet(PROCESSED_POSTS_KEY, {
        [postId]: `${state}:${lease.token}`,
      })
      await transaction.del(key)
      const result = await transaction.exec()
      return result.length === 2
    },
    promote: async (postId, lease) => {
      const key = claimKey(postId)
      const owner = leaseValue(lease)
      const promoted = promotionValue(lease)
      const [current, observedOwner] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      if (observedOwner !== owner) return 'lost'
      if (lease.kind === 'promotion-recovery') {
        return current === promoted ? 'authorized' : 'lost'
      }
      if (current !== undefined && current !== promoted) return 'lost'
      if (current === undefined) {
        await redis.hSetNX(PROCESSED_POSTS_KEY, postId, promoted)
      }
      const [stateAfter, ownerAfter] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      return stateAfter === promoted && ownerAfter === owner
        ? 'authorized'
        : 'lost'
    },
    inspectPromotion: async (postId, lease) => {
      try {
        const [current, owner] = await Promise.all([
          redis.hGet(PROCESSED_POSTS_KEY, postId),
          redis.get(claimKey(postId)),
        ])
        if (current === promotionValue(lease) && owner === leaseValue(lease))
          return 'authorized'
        if (
          lease.kind === 'fresh' &&
          current === undefined &&
          owner === leaseValue(lease)
        )
          return 'pre-submit'
        return 'lost'
      } catch {
        return 'unknown'
      }
    },
    authorizeWrite: async (postId, lease) => {
      const key = claimKey(postId)
      const transaction = await redis.watch(PROCESSED_POSTS_KEY, key)
      const [state, owner] = await Promise.all([
        redis.hGet(PROCESSED_POSTS_KEY, postId),
        redis.get(key),
      ])
      if (state !== promotionValue(lease) || owner !== leaseValue(lease)) {
        await transaction.unwatch()
        return false
      }
      await transaction.multi()
      await transaction.set(key, owner, {expiration: leaseExpiration()})
      const result = await transaction.exec()
      return result.length === 1
    },
    reconcile: reconcileReply,
    lookup: lookupLevel,
    format: formatReply,
    submitComment: async (postId, text) => {
      const comment = await reddit.submitComment({
        id: postId,
        text,
        runAs: 'APP',
      })
      return {
        id: comment.id,
        distinguishAndSticky: () => comment.distinguish(true),
      }
    },
    log: (severity, event) => emitLifecycleEvent(severity, event),
  }
}

function claimKey(postId: PostId): string {
  return `rgd-zbot:claim:${postId}`
}

function leaseValue(lease: ClaimLease): string {
  return lease.kind === 'fresh'
    ? `fresh:${lease.token}`
    : `recovery:${lease.token}:${lease.priorToken ?? ''}`
}

function leaseExpiration(): Date {
  return new Date(Date.now() + CLAIM_LEASE_MS)
}

function promotionValue(lease: ClaimLease): string {
  const token = lease.kind === 'fresh' ? lease.token : lease.priorToken
  return `promotion:${token ?? ''}`
}

function promotionTokenFromState(state: string): string | undefined {
  const match =
    /^promotion:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      state,
    )
  return match?.[1]
}

function leaseMayOwnState(
  lease: ClaimLease,
  state: string | undefined,
): boolean {
  if (lease.kind === 'fresh') {
    return state === undefined || state === promotionValue(lease)
  }
  return state === promotionValue(lease)
}

async function deleteLeaseIfOwner(
  postId: PostId,
  owner: string,
): Promise<void> {
  const key = claimKey(postId)
  const transaction = await redis.watch(key)
  if ((await redis.get(key)) !== owner) {
    await transaction.unwatch()
    return
  }
  await transaction.multi()
  await transaction.del(key)
  await transaction.exec()
}

async function reconcileReply(
  postId: PostId,
  levelId: string,
): Promise<ReconciliationResult> {
  try {
    const appUsername = (await reddit.getAppUser())?.username
    if (!appUsername) return 'inconclusive'

    const listing = reddit.getComments({postId, pageSize: 100, sort: 'new'})
    const comments = await listing.all()
    if (
      comments.some(
        comment =>
          comment.parentId === postId &&
          comment.authorName === appUsername &&
          comment.body.includes(levelId) &&
          comment.body.includes(FOOTER_MARKER),
      )
    )
      return 'found'
    return listing.hasMore ? 'inconclusive' : 'absent'
  } catch {
    return 'inconclusive'
  }
}

function isOnPostSubmitRequest(
  input: unknown,
): input is ValidOnPostSubmitRequest {
  if (!isRecord(input) || input.type !== 'PostSubmit') return false
  const post = input.post
  const author = input.author
  return (
    isRecord(post) &&
    typeof post.id === 'string' &&
    isPostId(post.id) &&
    typeof post.title === 'string' &&
    post.title.trim().length > 0 &&
    typeof post.createdAt === 'number' &&
    Number.isFinite(post.createdAt) &&
    isRecord(author) &&
    typeof author.name === 'string' &&
    author.name.trim().length > 0
  )
}

function isPostId(value: string): value is PostId {
  return /^t3_[a-z0-9]+$/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type RouteLifecycleEvent = {
  readonly event: 'invalid_trigger_payload' | 'request_failed'
  readonly stage: 'validation' | 'route'
  readonly outcome: 'rejected' | 'error'
  readonly category: 'invalid_payload' | 'internal_error'
  readonly summary?: string
}

function invalidTriggerPayload(): ErrorRsp {
  emitLifecycleEvent('warn', {
    event: 'invalid_trigger_payload',
    stage: 'validation',
    outcome: 'rejected',
    category: 'invalid_payload',
  })
  return {error: 'invalid trigger payload', status: 400}
}

function emitLifecycleEvent(
  severity: LogSeverity,
  event: LifecycleEvent | RouteLifecycleEvent,
): void {
  const serialized = JSON.stringify(event)
  if (severity === 'info') console.info(serialized)
  else if (severity === 'warn') console.warn(serialized)
  else console.error(serialized)
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  return JSON.parse(`${Buffer.concat(chunks)}`)
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
