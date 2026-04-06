import { pinyin } from 'pinyin-pro'
import type { Sample } from '@/types'
import { normalizePinyinToken } from '@/utils/pinyinNormalize'

const SEARCH_TOKEN_REGEX = /[a-z0-9\u3400-\u9fff]+/gi
const CHINESE_SEGMENT_REGEX = /[\u3400-\u9fff]+/g

const CHINESE_CHAR_REGEX = /[\u3400-\u9fff]/
const PLAIN_PINYIN_QUERY_REGEX = /^[a-zv]+$/i
const PINYINISH_QUERY_REGEX = /^[a-zv0-9]+$/i

type MatchKind =
  | 'exact'
  | 'prefix'
  | 'extended'
  | 'fuzzy'
  | 'direct-chinese'
  | 'fallback'

type SearchKeyword = {
  raw: string
  lower: string
  hasChinese: boolean
  isPureChinese: boolean
  isPinyinLike: boolean
  normalizedPinyin: string
  allowNormalizedPinyinPrefix: boolean
  chinesePinyinSequence: string[]
}

type SearchableToken = {
  value: string
  start: number
  normalizedPinyin: string
}

type ChineseSegment = {
  value: string
  start: number
  normalizedPinyinByChar: string[]
}

export type SampleSearchIndex = {
  sampleId: string
  fileNameLower: string
  fileNameTokens: SearchableToken[]
  fileNamePinyinTokens: SearchableToken[]
  chineseSegments: ChineseSegment[]
  relativePathLower: string
  fileExtLower: string
  hasChineseFileName: boolean
}

type KeywordMatch = {
  matched: true
  score: number
  position: number
  kind: MatchKind
}

export type SampleSearchMatch = {
  matched: true
  score: number
  earliestPosition: number
  kinds: MatchKind[]
}

export type SampleSearchOptions = {
  enableChinesePinyinFuzzySearch: boolean
}

type SampleSearchIndexCache = {
  samplesRef: Map<string, Sample> | null
  indexesById: Map<string, SampleSearchIndex>
}

const sampleSearchIndexCache: SampleSearchIndexCache = {
  samplesRef: null,
  indexesById: new Map(),
}

function isChineseChar(char: string): boolean {
  return CHINESE_CHAR_REGEX.test(char)
}

function getChineseCharNormalizedPinyin(char: string): string {
  try {
    const raw = pinyin(char, { toneType: 'none', type: 'array' })[0] ?? ''
    return normalizePinyinToken(raw)
  } catch {
    return ''
  }
}

function buildSearchableTokens(input: string): SearchableToken[] {
  const lower = input.toLowerCase()
  return Array.from(lower.matchAll(SEARCH_TOKEN_REGEX), (match) => {
    const value = match[0]
    return {
      value,
      start: match.index ?? 0,
      normalizedPinyin: normalizePinyinToken(value),
    }
  })
}

function buildChineseSegments(input: string): ChineseSegment[] {
  return Array.from(input.matchAll(CHINESE_SEGMENT_REGEX), (match) => ({
    value: match[0],
    start: match.index ?? 0,
    normalizedPinyinByChar: Array.from(match[0], (char) => getChineseCharNormalizedPinyin(char)),
  }))
}

function buildSearchKeyword(raw: string): SearchKeyword {
  const lower = raw.toLowerCase()
  const chars = Array.from(raw)
  const chineseChars = chars.filter((char) => isChineseChar(char))
  const normalizedPinyin = normalizePinyinToken(lower)

  return {
    raw,
    lower,
    hasChinese: chineseChars.length > 0,
    isPureChinese: chineseChars.length > 0 && chineseChars.length === chars.length,
    isPinyinLike: !chineseChars.length && PINYINISH_QUERY_REGEX.test(raw),
    normalizedPinyin,
    allowNormalizedPinyinPrefix: !chineseChars.length && PLAIN_PINYIN_QUERY_REGEX.test(raw) && normalizedPinyin.length > 0,
    chinesePinyinSequence: chineseChars.map((char) => getChineseCharNormalizedPinyin(char)).filter((value) => value.length > 0),
  }
}

export function parseSearchQuery(query: string): SearchKeyword[] {
  return query
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => buildSearchKeyword(part))
}

function buildSampleSearchIndex(sample: Sample): SampleSearchIndex {
  const normalizedPath = sample.filePath.replace(/\\/g, '/')
  const fileNameLower = sample.fileName.toLowerCase()
  const relativePathLower = normalizedPath.toLowerCase()
  const fileNameTokens = buildSearchableTokens(sample.fileName)
  const fileNamePinyinTokens = fileNameTokens.filter(
    (token) => token.normalizedPinyin.length > 0 && /[a-z]/.test(token.normalizedPinyin),
  )
  const chineseSegments = buildChineseSegments(sample.fileName)

  return {
    sampleId: sample.id,
    fileNameLower,
    fileNameTokens,
    fileNamePinyinTokens,
    chineseSegments,
    relativePathLower,
    fileExtLower: sample.fileExt.toLowerCase(),
    hasChineseFileName: chineseSegments.length > 0,
  }
}

export function getSampleSearchIndexMap(samples: Map<string, Sample>): Map<string, SampleSearchIndex> {
  if (sampleSearchIndexCache.samplesRef === samples) {
    return sampleSearchIndexCache.indexesById
  }

  const indexesById = new Map<string, SampleSearchIndex>()
  samples.forEach((sample) => {
    indexesById.set(sample.id, buildSampleSearchIndex(sample))
  })

  sampleSearchIndexCache.samplesRef = samples
  sampleSearchIndexCache.indexesById = indexesById

  return indexesById
}

function compareTokenPrefix(
  token: SearchableToken,
  queryLower: string,
  queryNormalizedPinyin: string,
  allowNormalizedPinyinPrefix: boolean,
): { matched: boolean; byNormalizedPinyin: boolean } {
  if (token.value.startsWith(queryLower)) {
    return { matched: true, byNormalizedPinyin: false }
  }

  if (
    allowNormalizedPinyinPrefix &&
    token.normalizedPinyin.length > 0 &&
    token.normalizedPinyin.startsWith(queryNormalizedPinyin)
  ) {
    return { matched: true, byNormalizedPinyin: true }
  }

  return { matched: false, byNormalizedPinyin: false }
}

function classifyPinyinPrefixMatch(token: SearchableToken, keyword: SearchKeyword): KeywordMatch | null {
  const prefixResult = compareTokenPrefix(
    token,
    keyword.lower,
    keyword.normalizedPinyin,
    keyword.allowNormalizedPinyinPrefix,
  )

  if (!prefixResult.matched) {
    return null
  }

  const comparedValue = prefixResult.byNormalizedPinyin ? token.normalizedPinyin : token.value
  const comparedQuery = prefixResult.byNormalizedPinyin ? keyword.normalizedPinyin : keyword.lower
  const nextChar = comparedValue.charAt(comparedQuery.length)

  // 拼音类搜索只允许从 token 起始位置命中，所以 "he" 不会召回 "she" / "che" / "zhe"。
  if (comparedValue === comparedQuery) {
    return {
      matched: true,
      score: 4200 - token.start * 8,
      position: token.start,
      kind: 'exact',
    }
  }

  // "主词 + 后缀" 视为强相关：he1 / he长 这类要排在 hen / heng 前面。
  if (/[0-9\u3400-\u9fff]/.test(nextChar)) {
    return {
      matched: true,
      score: 4000 - token.start * 8,
      position: token.start,
      kind: 'prefix',
    }
  }

  if (/[a-z]/.test(nextChar)) {
    return {
      matched: true,
      score: 3200 - token.start * 8,
      position: token.start,
      kind: 'extended',
    }
  }

  return {
    matched: true,
    score: 3600 - token.start * 8,
    position: token.start,
    kind: 'prefix',
  }
}

function matchChineseDirect(index: SampleSearchIndex, keyword: SearchKeyword): KeywordMatch | null {
  const position = index.fileNameLower.indexOf(keyword.lower)
  if (position === -1) {
    return null
  }

  return {
    matched: true,
    score: 4600 - position * 8,
    position,
    kind: 'direct-chinese',
  }
}

function matchChinesePinyinFuzzy(index: SampleSearchIndex, keyword: SearchKeyword): KeywordMatch | null {
  if (!index.hasChineseFileName || keyword.chinesePinyinSequence.length === 0) {
    return null
  }

  for (const segment of index.chineseSegments) {
    const limit = segment.normalizedPinyinByChar.length - keyword.chinesePinyinSequence.length
    for (let start = 0; start <= limit; start += 1) {
      const matches = keyword.chinesePinyinSequence.every(
        (queryPinyin, offset) => segment.normalizedPinyinByChar[start + offset] === queryPinyin,
      )

      if (!matches) {
        continue
      }

      // 中文模糊召回只检查中文片段的拼音序列，因此搜索“和”会命中“何”“合”，但不会把纯拼音 he / he1 混进来。
      const position = segment.start + start
      return {
        matched: true,
        score: 2800 - position * 8,
        position,
        kind: 'fuzzy',
      }
    }
  }

  return null
}

function matchFallback(index: SampleSearchIndex, keyword: SearchKeyword): KeywordMatch | null {
  if (!keyword.lower) {
    return null
  }

  const fileNamePosition = index.fileNameLower.indexOf(keyword.lower)
  if (fileNamePosition !== -1) {
    return {
      matched: true,
      score: 1800 - fileNamePosition * 4,
      position: fileNamePosition,
      kind: 'fallback',
    }
  }

  const pathPosition = index.relativePathLower.indexOf(keyword.lower)
  if (pathPosition !== -1) {
    return {
      matched: true,
      score: 900 - pathPosition * 2,
      position: pathPosition + 1000,
      kind: 'fallback',
    }
  }

  if (index.fileExtLower.startsWith(keyword.lower)) {
    return {
      matched: true,
      score: 700,
      position: 2000,
      kind: 'fallback',
    }
  }

  return null
}

function matchKeyword(index: SampleSearchIndex, keyword: SearchKeyword, options: SampleSearchOptions): KeywordMatch | null {
  if (keyword.hasChinese) {
    const directMatch = matchChineseDirect(index, keyword)
    if (directMatch) {
      return directMatch
    }

    if (options.enableChinesePinyinFuzzySearch && keyword.isPureChinese) {
      return matchChinesePinyinFuzzy(index, keyword)
    }

    return null
  }

  if (keyword.isPinyinLike) {
    let bestMatch: KeywordMatch | null = null

    for (const token of index.fileNamePinyinTokens) {
      const match = classifyPinyinPrefixMatch(token, keyword)
      if (!match) {
        continue
      }

      if (!bestMatch || match.score > bestMatch.score) {
        bestMatch = match
      }
    }

    if (bestMatch) {
      return bestMatch
    }
  }

  return matchFallback(index, keyword)
}

export function matchSampleSearch(
  index: SampleSearchIndex,
  keywords: SearchKeyword[],
  options: SampleSearchOptions,
): SampleSearchMatch | null {
  if (keywords.length === 0) {
    return {
      matched: true,
      score: 0,
      earliestPosition: Number.MAX_SAFE_INTEGER,
      kinds: [],
    }
  }

  let score = 0
  let earliestPosition = Number.MAX_SAFE_INTEGER
  const kinds: MatchKind[] = []

  for (const keyword of keywords) {
    const match = matchKeyword(index, keyword, options)
    if (!match) {
      return null
    }

    score += match.score
    earliestPosition = Math.min(earliestPosition, match.position)
    kinds.push(match.kind)
  }

  return {
    matched: true,
    score,
    earliestPosition,
    kinds,
  }
}

export function compareSampleSearchMatches(
  leftSample: Sample,
  leftMatch: SampleSearchMatch,
  rightSample: Sample,
  rightMatch: SampleSearchMatch,
): number {
  if (rightMatch.score !== leftMatch.score) {
    return rightMatch.score - leftMatch.score
  }

  if (leftMatch.earliestPosition !== rightMatch.earliestPosition) {
    return leftMatch.earliestPosition - rightMatch.earliestPosition
  }

  const byName = leftSample.fileName.localeCompare(rightSample.fileName, undefined, { sensitivity: 'base' })
  if (byName !== 0) {
    return byName
  }

  return leftSample.importedAt - rightSample.importedAt
}
