import type { Sample } from '@/types'
import type {
  LyricsAssemblyPlan,
  LyricsMatchedItem,
  LyricsSourceSampleIndex,
  LyricToken,
} from '@/types/lyrics'
import { normalizePinyinToken } from '@/utils/pinyinNormalize'

function addToIndex(map: Map<string, Sample[]>, key: string, sample: Sample) {
  if (!key) return
  const existing = map.get(key)
  if (existing) {
    existing.push(sample)
  } else {
    map.set(key, [sample])
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function extractCharKeys(fileName: string): string[] {
  return unique(Array.from(fileName.matchAll(/[\u3400-\u9fff]/g), (match) => match[0]))
}

function extractPinyinKeys(fileName: string): string[] {
  const normalized = fileName.toLowerCase()
  return unique(
    normalized
      .split(/[^a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹḿ0-9]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 1 && part.length <= 8),
  )
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'sample'
}

function createOrderedFileName(index: number, total: number, char: string, pinyin: string, ext: string): string {
  const width = Math.max(3, String(total).length)
  const orderText = String(index).padStart(width, '0')
  const charPart = sanitizeFileSegment(char)
  const pinyinPart = sanitizeFileSegment((pinyin || 'na').toLowerCase())
  return `${orderText}_${charPart}_${pinyinPart}${ext}`
}

export function buildLyricsSourceSampleIndex(sourceSamples: Sample[]): LyricsSourceSampleIndex {
  const byChar = new Map<string, Sample[]>()
  const byPinyin = new Map<string, Sample[]>()
  const byPinyinNormalized = new Map<string, Sample[]>()

  for (const sample of sourceSamples) {
    extractCharKeys(sample.fileName).forEach((charKey) => addToIndex(byChar, charKey, sample))
    extractPinyinKeys(sample.fileName).forEach((pinyinKey) => {
      addToIndex(byPinyin, pinyinKey, sample)

      const normalizedKey = normalizePinyinToken(pinyinKey)
      addToIndex(byPinyinNormalized, normalizedKey, sample)
    })
  }

  return { byChar, byPinyin, byPinyinNormalized }
}

export function planLyricsAssembly(tokens: LyricToken[], sourceIndex: LyricsSourceSampleIndex): LyricsAssemblyPlan {
  const charTokens = tokens.filter((token): token is Extract<LyricToken, { type: 'char' }> => token.type === 'char')
  const matched: LyricsMatchedItem[] = []
  const missing: LyricsAssemblyPlan['missing'] = []

  charTokens.forEach((token, charIndex) => {
    const index = charIndex + 1
    const byChar = sourceIndex.byChar.get(token.char)?.[0]
    const normalizedPinyin = normalizePinyinToken(token.pinyin)
    const byPinyinNormalized = normalizedPinyin
      ? sourceIndex.byPinyinNormalized.get(normalizedPinyin)?.[0]
      : undefined
    const sample = byChar ?? byPinyinNormalized

    if (!sample) {
      missing.push({
        index,
        char: token.char,
        pinyin: token.pinyin,
      })
      return
    }

    matched.push({
      id: `lyrics_match_${index}`,
      index,
      token,
      sample,
      targetFileName: createOrderedFileName(index, charTokens.length, token.char, token.pinyin, sample.fileExt),
      matchedBy: byChar ? 'char' : 'pinyin-normalized',
    })
  })

  return { matched, missing }
}
