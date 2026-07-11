import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeStagedLyricsAssemblies, migratePersistedSamplePaths } from './copyMigration'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('migratePersistedSamplePaths', () => {
  it('rewrites a legacy lyrics assembly path when the migrated file exists', () => {
    const legacyRoot = 'D:\\Apps\\sample-manager\\Copy'
    const targetRoot = 'C:\\Users\\Tester\\AppData\\Roaming\\sample-manager\\Copy'
    const targetPath = `${targetRoot}\\lyrics-assemblies\\group_1\\001.wav`

    const result = migratePersistedSamplePaths(
      {
        sample: {
          id: 'sample',
          filePath: `${legacyRoot}\\lyrics-assemblies\\group_1\\001.wav`,
        },
      },
      legacyRoot,
      targetRoot,
      (candidate) => candidate === targetPath,
    )

    expect(result.changed).toBe(true)
    expect(result.samples.sample.filePath).toBe(targetPath)
  })

  it('keeps the legacy path when the migrated file is missing', () => {
    const legacyRoot = 'D:\\Apps\\sample-manager\\Copy'
    const originalPath = `${legacyRoot}\\lyrics-assemblies\\group_1\\001.wav`
    const samples = { sample: { id: 'sample', filePath: originalPath } }

    const result = migratePersistedSamplePaths(
      samples,
      legacyRoot,
      'C:\\Users\\Tester\\AppData\\Roaming\\sample-manager\\Copy',
      () => false,
    )

    expect(result.changed).toBe(false)
    expect(result.samples.sample.filePath).toBe(originalPath)
  })

  it('does not rewrite a similarly-prefixed path outside the legacy Copy directory', () => {
    const samples = {
      sample: {
        id: 'sample',
        filePath: 'D:\\Apps\\sample-manager\\Copy-backup\\lyrics-assemblies\\001.wav',
      },
    }

    const result = migratePersistedSamplePaths(
      samples,
      'D:\\Apps\\sample-manager\\Copy',
      'C:\\Users\\Tester\\AppData\\Roaming\\sample-manager\\Copy',
      () => true,
    )

    expect(result.changed).toBe(false)
    expect(result.samples).toEqual(samples)
  })

  it('is idempotent after a path has already been migrated', () => {
    const targetRoot = 'C:\\Users\\Tester\\AppData\\Roaming\\sample-manager\\Copy'
    const samples = {
      sample: {
        id: 'sample',
        filePath: `${targetRoot}\\lyrics-assemblies\\group_1\\001.wav`,
      },
    }

    const result = migratePersistedSamplePaths(
      samples,
      'D:\\Apps\\sample-manager\\Copy',
      targetRoot,
      () => true,
    )

    expect(result.changed).toBe(false)
    expect(result.samples).toEqual(samples)
  })

  it('merges staged lyrics assemblies without overwriting an existing target file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sample-manager-copy-migration-'))
    temporaryDirectories.push(root)
    const stagingRoot = join(root, 'copy-migration')
    const targetRoot = join(root, 'Copy')
    const stagedFile = join(stagingRoot, 'lyrics-assemblies', 'group_1', '001.wav')
    const targetFile = join(targetRoot, 'lyrics-assemblies', 'group_1', '001.wav')

    await mkdir(join(stagingRoot, 'lyrics-assemblies', 'group_1'), { recursive: true })
    await mkdir(join(targetRoot, 'lyrics-assemblies', 'group_1'), { recursive: true })
    await writeFile(stagedFile, 'legacy')
    await writeFile(targetFile, 'current')

    await mergeStagedLyricsAssemblies(stagingRoot, targetRoot)

    expect(await readFile(targetFile, 'utf8')).toBe('current')
    await expect(readFile(stagedFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies a staged file when the target does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sample-manager-copy-migration-'))
    temporaryDirectories.push(root)
    const stagingRoot = join(root, 'copy-migration')
    const targetRoot = join(root, 'Copy')
    const stagedFile = join(stagingRoot, 'lyrics-assemblies', 'group_1', '001.wav')
    const targetFile = join(targetRoot, 'lyrics-assemblies', 'group_1', '001.wav')

    await mkdir(join(stagingRoot, 'lyrics-assemblies', 'group_1'), { recursive: true })
    await writeFile(stagedFile, 'legacy')

    await mergeStagedLyricsAssemblies(stagingRoot, targetRoot)

    expect(await readFile(targetFile, 'utf8')).toBe('legacy')
  })
})
