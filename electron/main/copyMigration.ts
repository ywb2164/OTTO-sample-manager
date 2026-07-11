import { access, cp, mkdir, rm } from 'fs/promises'
import { win32 } from 'path'

export interface PersistedSampleRecord {
  filePath?: unknown
  [key: string]: unknown
}

export interface PersistedSamplePathMigrationResult {
  samples: Record<string, PersistedSampleRecord>
  changed: boolean
}

export async function mergeStagedLyricsAssemblies(
  stagingRoot: string,
  targetCopyRoot: string,
): Promise<void> {
  const stagedLyricsRoot = win32.join(stagingRoot, 'lyrics-assemblies')
  const targetLyricsRoot = win32.join(targetCopyRoot, 'lyrics-assemblies')

  try {
    await access(stagedLyricsRoot)
  } catch {
    return
  }

  await mkdir(targetLyricsRoot, { recursive: true })
  await cp(stagedLyricsRoot, targetLyricsRoot, {
    recursive: true,
    force: false,
    errorOnExist: false,
  })
  await rm(stagingRoot, { recursive: true, force: true })
}

export function migratePersistedSamplePaths(
  samples: Record<string, PersistedSampleRecord>,
  legacyCopyRoot: string,
  targetCopyRoot: string,
  targetExists: (filePath: string) => boolean,
): PersistedSamplePathMigrationResult {
  let changed = false
  const migratedSamples: Record<string, PersistedSampleRecord> = {}

  for (const [id, sample] of Object.entries(samples)) {
    if (typeof sample.filePath !== 'string') {
      migratedSamples[id] = sample
      continue
    }

    const relativePath = win32.relative(legacyCopyRoot, sample.filePath)
    const isLyricsAssembly =
      relativePath !== '' &&
      !relativePath.startsWith('..') &&
      !win32.isAbsolute(relativePath) &&
      relativePath.toLowerCase().startsWith('lyrics-assemblies\\')
    const targetPath = win32.join(targetCopyRoot, relativePath)

    if (!isLyricsAssembly || !targetExists(targetPath)) {
      migratedSamples[id] = sample
      continue
    }

    migratedSamples[id] = { ...sample, filePath: targetPath }
    changed = true
  }

  return { samples: migratedSamples, changed }
}
