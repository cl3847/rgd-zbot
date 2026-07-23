import {Buffer} from 'node:buffer'

const BOOMLINGS_URL = 'https://www.boomlings.com/database/getGJLevels21.php'
const DEFAULT_TIMEOUT_MS = 15_000

export type BoomlingsErrorCategory =
  | 'timeout'
  | 'http_status'
  | 'malformed_response'

const OFFICIAL_SONGS = [
  'Stereo Madness',
  'Back on Track',
  'Polargeist',
  'Dry Out',
  'Base After Base',
  'Cant Let Go',
  'Jumper',
  'Time Machine',
  'Cycles',
  'xStep',
  'Clutterfunk',
  'Theory of Everything',
  'Electroman Adventures',
  'Clubstep',
  'Electrodynamix',
  'Hexagon Force',
  'Blast Processing',
  'Theory of Everything 2',
  'Geometrical Dominator',
  'Deadlocked',
  'Fingerdash',
  'Dash',
] as const

export type LevelInfo = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly creatorUsername: string
  readonly difficulty: string
  readonly stars: number
  readonly downloads: number
  readonly likes: number
  readonly length: string
  readonly songName: string
  readonly songArtist: string
  readonly songId: number
  readonly isOfficialSong: boolean
}

export class BoomlingsProtocolError extends Error {
  readonly category: BoomlingsErrorCategory

  constructor(category: BoomlingsErrorCategory, message: string) {
    super(message)
    this.name = 'BoomlingsProtocolError'
    this.category = category
  }
}

export async function lookupLevel(
  id: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LevelInfo | null> {
  if (!/^\d{6,10}$/.test(id)) {
    throw new TypeError('level ID must contain 6 to 10 digits')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Boomlings timeout must be a positive integer')
  }

  const body = new URLSearchParams({
    secret: 'Wmfd2893gb7',
    type: '0',
    str: id,
    count: '1',
  })
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(BOOMLINGS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': '',
      },
      body,
      signal,
    })
  } catch {
    throw requestFailure(signal)
  }

  if (!response.ok) {
    throw new BoomlingsProtocolError(
      'http_status',
      `Boomlings request failed with HTTP ${response.status}`,
    )
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    throw requestFailure(signal)
  }
  if (raw.trim() === '-1') return null

  const sections = raw.split('#')
  const values = parseStrideMap(sections[0] ?? '', ':')
  const actualId = values.get('1')
  if (!actualId) {
    throw new BoomlingsProtocolError(
      'malformed_response',
      'Boomlings returned malformed level data',
    )
  }
  if (actualId !== id) return null

  const creators = parseCreators(sections[1] ?? '')
  const creatorUsername = creators.get(values.get('6') ?? '') ?? '-'
  const song = resolveSong(values, sections[2])

  return {
    id: actualId,
    name: values.get('2') ?? '',
    description: decodeDescription(values.get('3')),
    creatorUsername,
    difficulty: resolveDifficulty(values),
    stars: parseUnsigned(values.get('18')),
    downloads: parseUnsigned(values.get('10')),
    likes: parseSigned(values.get('14')),
    length: resolveLength(values),
    ...song,
  }
}

function parseStrideMap(
  section: string,
  separator: string,
): Map<string, string> {
  const fields = section.split(separator)
  const values = new Map<string, string>()
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const key = fields[index]
    const value = fields[index + 1]
    if (key !== undefined && value !== undefined) values.set(key, value)
  }
  return values
}

function parseCreators(section: string): Map<string, string> {
  const creators = new Map<string, string>()
  for (const entry of section.split('|')) {
    if (!entry) continue
    const [playerId, username] = entry.split(':', 3)
    if (playerId !== undefined && username !== undefined) {
      creators.set(playerId, username)
    }
  }
  return creators
}

function decodeDescription(raw: string | undefined): string {
  if (!raw) return ''

  try {
    const bytes = decodeBase64UrlNoPad(raw) ?? decodeStandardBase64(raw)
    if (!bytes) return ''
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes).trim()
  } catch {
    return ''
  }
}

function decodeBase64UrlNoPad(raw: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw) || raw.length % 4 === 1) {
    return undefined
  }

  const bytes = Buffer.from(raw, 'base64url')
  return bytes.toString('base64url') === raw ? bytes : undefined
}

function decodeStandardBase64(raw: string): Buffer | undefined {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw,
    )
  ) {
    return undefined
  }

  const bytes = Buffer.from(raw, 'base64')
  return bytes.toString('base64') === raw ? bytes : undefined
}

function requestFailure(signal: AbortSignal): BoomlingsProtocolError {
  return signal.aborted
    ? new BoomlingsProtocolError('timeout', 'Boomlings request timed out')
    : new BoomlingsProtocolError(
        'malformed_response',
        'Boomlings request failed',
      )
}

function parseUnsigned(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : 0
}

function parseSigned(raw: string | undefined): number {
  if (!raw || !/^-?\d+$/.test(raw)) return 0
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : 0
}

function resolveDifficulty(values: ReadonlyMap<string, string>): string {
  if (values.get('17') === '1') {
    const demons: Readonly<Record<string, string>> = {
      '3': 'Easy Demon',
      '4': 'Medium Demon',
      '5': 'Insane Demon',
      '6': 'Extreme Demon',
    }
    return demons[values.get('43') ?? ''] ?? 'Hard Demon'
  }
  if (values.get('25') === '1') return 'Auto'

  const difficulties: Readonly<Record<string, string>> = {
    '10': 'Easy',
    '20': 'Normal',
    '30': 'Hard',
    '40': 'Harder',
    '50': 'Insane',
  }
  return difficulties[values.get('9') ?? ''] ?? 'N/A'
}

function resolveLength(values: ReadonlyMap<string, string>): string {
  const lengths: Readonly<Record<string, string>> = {
    '0': 'Tiny',
    '1': 'Short',
    '2': 'Medium',
    '3': 'Long',
    '4': 'XL',
    '5': 'Platformer',
  }
  return lengths[values.get('15') ?? ''] ?? 'Unknown'
}

function resolveSong(
  values: ReadonlyMap<string, string>,
  songSection: string | undefined,
): Pick<LevelInfo, 'songName' | 'songArtist' | 'songId' | 'isOfficialSong'> {
  const customSongId = values.get('35')
  if (!customSongId || customSongId === '0') {
    const songId = parseUnsigned(values.get('11'))
    return {
      songName: OFFICIAL_SONGS[songId] ?? 'Unknown',
      songArtist: 'RobTop',
      songId,
      isOfficialSong: true,
    }
  }

  const songId = parseUnsigned(customSongId)
  const songValues = parseStrideMap(songSection ?? '', '~|~')
  if (songValues.get('1') !== customSongId) {
    return {
      songName: 'Unknown',
      songArtist: 'Unknown',
      songId,
      isOfficialSong: false,
    }
  }
  return {
    songName: songValues.get('2') ?? 'Unknown',
    songArtist: songValues.get('4') ?? 'Unknown',
    songId,
    isOfficialSong: false,
  }
}
