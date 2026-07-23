import assert from 'node:assert/strict'
import test from 'node:test'
import {findLevelId} from './level-id.ts'

function matches(title: string): boolean {
  return findLevelId(title) !== undefined
}

function extracts(title: string): string {
  const id = findLevelId(title)
  assert.ok(id, `expected a level ID in ${JSON.stringify(title)}`)
  return id
}

test('TRIG-01 extracts every explicit Rust title form', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['id 12345678', '12345678'],
    ['ID: 12345678', '12345678'],
    ['id=12345678', '12345678'],
    ['id is 12345678', '12345678'],
    ['ID 12345678', '12345678'],
    ['my level id 12345678 is cool', '12345678'],
    ['(id 12345678)', '12345678'],
    ['[id 12345678]', '12345678'],
    ['great level! id 12345678', '12345678'],
    ['level.id 12345678', '12345678'],
    ['-id 12345678', '12345678'],
    ['id12345678 is a cool level', '12345678'],
  ]

  for (const [title, expected] of cases) assert.equal(extracts(title), expected)
})

test('TRIG-01 extracts bracketed and Reddit-escaped title forms', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['[12345678]', '12345678'],
    ['(12345678)', '12345678'],
    ['check this level [12345678] out', '12345678'],
    ['\\[12345678\\]', '12345678'],
  ]

  for (const [title, expected] of cases) assert.equal(extracts(title), expected)
})

test('TRIG-01 accepts only the six through ten digit boundaries', () => {
  assert.equal(extracts('id 123456'), '123456')
  assert.equal(extracts('id 1234567890'), '1234567890')
  assert.equal(matches('id 12345'), false)
  assert.equal(matches('id 12345678901'), false)
})

test('TRIG-01 rejects Rust-corpus false positives', () => {
  const titles = [
    'valid 12345678',
    'said 12345678',
    'rapid 12345678',
    'squid 12345678',
    'void12345678',
    'abc[12345678]',
    'abc(12345678)',
    '12345678',
    'I got 12345678 points',
    'chapter 12345678',
    'https://example.com/profile/12345678901',
    '[12345678',
    '(12345678',
    '[12345678]x',
    '[12345678],',
  ]

  for (const title of titles) assert.equal(matches(title), false, title)
})

test('TRIG-01 preserves first-pattern precedence over an earlier bracketed ID', () => {
  assert.equal(findLevelId('[12345678] then id 87654321'), '87654321')
})
