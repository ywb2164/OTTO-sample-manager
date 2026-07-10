import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanAudioFolder } from './folderScanner'

const temporaryDirectories: string[] = []

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'otto-folder-scan-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('scanAudioFolder', () => {
  it('preserves nested folders and counts supported extensions case-insensitively', () => {
    const root = createTemporaryDirectory()
    const child = join(root, 'A')
    const empty = join(root, 'empty')
    mkdirSync(child)
    mkdirSync(empty)
    writeFileSync(join(root, 'root.WAV'), 'audio')
    writeFileSync(join(child, 'child.flac'), 'audio')
    writeFileSync(join(child, 'ignore.txt'), 'text')

    const result = scanAudioFolder(root)

    expect(result.scannedFileCount).toBe(2)
    expect(result.failures).toEqual([])
    expect(result.root?.files).toEqual([join(root, 'root.WAV')])
    expect(result.root?.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'A', files: [join(child, 'child.flac')] }),
      expect.objectContaining({ name: 'empty', files: [], children: [] }),
    ]))
  })

  it('continues scanning siblings and reports an unreadable child directory', () => {
    const root = createTemporaryDirectory()
    const readable = join(root, 'readable')
    const blocked = join(root, 'blocked')
    mkdirSync(readable)
    mkdirSync(blocked)
    writeFileSync(join(readable, 'ok.wav'), 'audio')
    writeFileSync(join(blocked, 'hidden.wav'), 'audio')

    const result = scanAudioFolder(root, (directory) => {
      if (directory === blocked) {
        throw new Error('access denied')
      }
      return readdirSync(directory, { withFileTypes: true })
    })

    expect(result.scannedFileCount).toBe(1)
    expect(result.root?.children.map((child) => child.name)).toEqual(['readable'])
    expect(result.failures).toEqual([
      { path: blocked, stage: 'scan', reason: 'access denied' },
    ])
  })

  it('returns a null root and a diagnostic when the selected root cannot be read', () => {
    const root = join(createTemporaryDirectory(), 'missing')

    const result = scanAudioFolder(root)

    expect(result.root).toBeNull()
    expect(result.scannedFileCount).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ path: root, stage: 'scan' })
  })
})
