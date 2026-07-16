import type { Sample } from '@/types'
import type { LibraryMutationBatch, LibrarySampleRecord } from './desktopBridge'
import { getDesktopBridgeIfAvailable } from './desktopBridge'

function emptyBatch(): LibraryMutationBatch {
  return {
    upsertSamples: [],
    deleteSampleIds: [],
    upsertFolders: [],
    deleteFolderIds: [],
    upsertGroups: [],
    deleteGroupIds: [],
  }
}

function sampleRecord(sample: Sample): LibrarySampleRecord {
  return {
    id: sample.id,
    folderId: sample.folderId ?? null,
    filePath: sample.filePath,
    fileName: sample.fileName,
    extension: sample.fileExt,
    originalId: sample.originalId,
    isCopy: sample.isCopy,
    copyIndex: sample.copyIndex,
    fileSize: sample.fileSize,
    durationMs: sample.duration > 0 ? Math.round(sample.duration * 1000) : null,
    sampleRate: sample.sampleRate > 0 ? sample.sampleRate : null,
    channels: sample.channels > 0 ? sample.channels : null,
    isValid: sample.isFileValid,
    importedAt: sample.importedAt,
    groupIds: [...sample.groupIds],
  }
}

function reportFailure(error: unknown): void {
  console.error('SQLite 分页素材保存失败', error)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('otto:persistence-error', {
      detail: error instanceof Error ? error.message : String(error),
    }))
  }
}

function apply(batch: LibraryMutationBatch): void {
  const desktop = getDesktopBridgeIfAvailable()
  if (desktop?.runtime !== 'tauri') return
  void desktop.library.applyMutations(batch).catch(reportFailure)
}

export function persistPagedSampleDeletes(sampleIds: string[]): void {
  if (sampleIds.length === 0) return
  apply({ ...emptyBatch(), deleteSampleIds: [...sampleIds] })
}

export function persistPagedSample(sample: Sample): void {
  apply({ ...emptyBatch(), upsertSamples: [sampleRecord(sample)] })
}

export function persistPagedSampleGroups(
  replacements: Array<{ sampleId: string; groupIds: string[] }>,
): void {
  if (replacements.length === 0) return
  apply({
    ...emptyBatch(),
    replaceSampleGroups: replacements.map((replacement) => ({
      sampleId: replacement.sampleId,
      groupIds: [...replacement.groupIds],
    })),
  })
}
