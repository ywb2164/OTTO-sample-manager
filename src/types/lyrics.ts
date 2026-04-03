import type { Sample } from '@/types'

export type LyricToken =
  | { type: 'char'; char: string; pinyin: string }
  | { type: 'newline'; raw: '\n' }
  | { type: 'separator'; raw: string }

export interface LyricsMissingItem {
  index: number
  char: string
  pinyin: string
}

export interface LyricsMatchedItem {
  id: string
  index: number
  token: Extract<LyricToken, { type: 'char' }>
  sample: Sample
  targetFileName: string
  matchedBy: 'char' | 'pinyin-normalized'
}

export interface LyricsSourceSampleIndex {
  byChar: Map<string, Sample[]>
  byPinyin: Map<string, Sample[]>
  byPinyinNormalized: Map<string, Sample[]>
}

export interface LyricsAssemblyPlan {
  matched: LyricsMatchedItem[]
  missing: LyricsMissingItem[]
}

export interface LyricsAssemblyCopyItem {
  id: string
  sourcePath: string
  fileName: string
}

export interface LyricsAssemblyCopyResultItem {
  id: string
  sourcePath: string
  targetPath: string
  fileSize: number
}
