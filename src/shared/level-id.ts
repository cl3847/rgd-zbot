const ID_PATTERNS = [
  /(?:^|[ .?!(-]|\[)id(?: is|[:=])? ?([0-9]{6,10})\b/i,
  /(?:^| )\\?(?:\[|\()([0-9]{6,10})\\?(?:\]|\))(?:$| )/,
]

export function findLevelId(title: string): string | undefined {
  for (const pattern of ID_PATTERNS) {
    const match = pattern.exec(title)
    if (match?.[1]) return match[1]
  }
  return undefined
}
