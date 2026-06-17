import { describe, expect, it } from 'vitest'
import type { Sample } from '@/types'
import {
  getSampleSearchIndexMap,
  matchSampleSearch,
  parseSearchQuery,
} from './sampleSearch'

function createSample(overrides: Partial<Sample>): Sample {
  const fileName = overrides.fileName ?? 'sample'
  const fileExt = overrides.fileExt ?? '.wav'

  return {
    id: overrides.id ?? `${fileName}-${fileExt}`,
    fileName,
    fileExt,
    filePath: overrides.filePath ?? `D:/samples/${fileName}${fileExt}`,
    folderId: overrides.folderId ?? null,
    originalId: overrides.originalId ?? `${fileName}-${fileExt}`,
    isCopy: overrides.isCopy ?? false,
    copyIndex: overrides.copyIndex ?? 0,
    duration: overrides.duration ?? 0,
    sampleRate: overrides.sampleRate ?? 44100,
    channels: overrides.channels ?? 2,
    fileSize: overrides.fileSize ?? 1024,
    groupIds: overrides.groupIds ?? [],
    importedAt: overrides.importedAt ?? 1,
    isDecoded: overrides.isDecoded ?? false,
    isFileValid: overrides.isFileValid ?? true,
  }
}

function searchMatches(sample: Sample, query: string): boolean {
  const samples = new Map([[sample.id, sample]])
  const index = getSampleSearchIndexMap(samples).get(sample.id)

  if (!index) {
    throw new Error(`Missing search index for ${sample.id}`)
  }

  return Boolean(matchSampleSearch(index, parseSearchQuery(query), {
    enableChinesePinyinFuzzySearch: false,
  }))
}

describe('sample search', () => {
  it('matches audio by file name', () => {
    const sample = createSample({
      id: 'kick',
      fileName: 'kick',
      filePath: 'D:/library/drums/kick.wav',
    })

    expect(searchMatches(sample, 'kick')).toBe(true)
  })

  it('does not match unrelated audio by parent folder name', () => {
    const sample = createSample({
      id: 'snare',
      fileName: 'snare',
      filePath: 'D:/library/kick/snare.wav',
    })

    expect(searchMatches(sample, 'kick')).toBe(false)
  })

  it('matches Chinese text directly in the file name', () => {
    const sample = createSample({
      id: 'fei',
      fileName: '飞',
      filePath: 'D:/library/chinese/飞.wav',
    })

    expect(searchMatches(sample, '飞')).toBe(true)
  })

  it('matches pinyin prefixes from the file name token without using the path', () => {
    const matchingSample = createSample({
      id: 'he-token',
      fileName: 'he1',
      filePath: 'D:/library/random/he1.wav',
    })
    const pathOnlySample = createSample({
      id: 'he-folder',
      fileName: 'random',
      filePath: 'D:/library/he/random.wav',
    })

    expect(searchMatches(matchingSample, 'he')).toBe(true)
    expect(searchMatches(pathOnlySample, 'he')).toBe(false)
  })

  it('matches one-letter pinyin prefixes from Chinese file names', () => {
    const sample = createSample({
      id: 'shun',
      fileName: '顺',
      filePath: 'D:/library/chinese/顺.wav',
    })

    expect(searchMatches(sample, 's')).toBe(true)
  })

  it('matches two-letter pinyin prefixes from Chinese file names', () => {
    const sample = createSample({
      id: 'shun',
      fileName: '顺',
      filePath: 'D:/library/chinese/顺.wav',
    })

    expect(searchMatches(sample, 'sh')).toBe(true)
  })

  it('matches short pinyin prefixes from the first Chinese character', () => {
    const sample = createSample({
      id: 'tv',
      fileName: '电视',
      filePath: 'D:/library/chinese/电视.wav',
    })

    expect(searchMatches(sample, 'd')).toBe(true)
    expect(searchMatches(sample, 'di')).toBe(true)
  })

  it('does not return unrelated Chinese file names for short pinyin prefixes', () => {
    const sample = createSample({
      id: 'ma',
      fileName: '马',
      filePath: 'D:/library/chinese/马.wav',
    })

    expect(searchMatches(sample, 's')).toBe(false)
    expect(searchMatches(sample, 'sh')).toBe(false)
  })

  it('does not treat symbol-only queries as match-all', () => {
    const sample = createSample({
      id: 'kick',
      fileName: 'kick',
      filePath: 'D:/library/drums/kick.wav',
    })

    expect(searchMatches(sample, '$')).toBe(false)
  })
})
