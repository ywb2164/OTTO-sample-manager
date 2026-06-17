import { describe, expect, it } from 'vitest'
import type { Sample } from '@/types'
import type { LyricToken } from '@/types/lyrics'
import { buildLyricsSourceSampleIndex, planLyricsAssembly } from './lyricsSampleAssembler'

function createSample(id: string, fileName: string): Sample {
  return {
    id,
    fileName,
    fileExt: '.wav',
    filePath: `D:/samples/${fileName}.wav`,
    folderId: null,
    originalId: id,
    isCopy: false,
    copyIndex: 0,
    duration: 0,
    sampleRate: 44100,
    channels: 2,
    fileSize: 1024,
    groupIds: ['source'],
    importedAt: 1,
    isDecoded: false,
    isFileValid: true,
  }
}

function createCharToken(char: string, pinyin: string): Extract<LyricToken, { type: 'char' }> {
  return { type: 'char', char, pinyin }
}

function matchFirstSample(samples: Sample[], token = createCharToken('草', 'cao')) {
  const plan = planLyricsAssembly([token], buildLyricsSourceSampleIndex(samples))
  const matched = plan.matched[0]

  if (!matched) {
    throw new Error('Expected a lyrics match')
  }

  return matched
}

describe('lyrics sample assembler', () => {
  it('prefers exact pinyin file names over Chinese character file names', () => {
    const matched = matchFirstSample([
      createSample('char', '草'),
      createSample('pinyin', 'cao'),
    ])

    expect(matched.sample.id).toBe('pinyin')
    expect(matched.matchedBy).toBe('pinyin-exact-name')
  })

  it('treats pinyin plus tone number as the same highest priority', () => {
    const matched = matchFirstSample([
      createSample('char', '草'),
      createSample('tone', 'cao2'),
    ])

    expect(matched.sample.id).toBe('tone')
    expect(matched.matchedBy).toBe('pinyin-exact-name')
  })

  it('uses pinyin tokens before Chinese character file names when exact names are unavailable', () => {
    const matched = matchFirstSample([
      createSample('char', '草'),
      createSample('token', '001_cao'),
    ])

    expect(matched.sample.id).toBe('token')
    expect(matched.matchedBy).toBe('pinyin-token')
  })

  it('falls back to Chinese character file names for existing libraries', () => {
    const matched = matchFirstSample([
      createSample('char', '草'),
    ])

    expect(matched.sample.id).toBe('char')
    expect(matched.matchedBy).toBe('char')
  })
})
