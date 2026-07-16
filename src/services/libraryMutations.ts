import type { Sample, SampleFolder, SampleGroup } from '@/types'
import type {
  LibraryFolderRecord,
  LibraryGroupRecord,
  LibraryMutationBatch,
  LibrarySampleRecord,
} from './desktopBridge'

export interface LibraryPersistenceState {
  samples: Map<string, Sample>
  folders: Map<string, SampleFolder>
  groups: Map<string, SampleGroup>
  folderOrder: string[]
  groupOrder: string[]
  expandedFolderIds: Set<string>
  folderSettings: Record<string, unknown>
}

export interface LibraryPersistenceSnapshot {
  samples: Map<string, LibrarySampleRecord>
  folders: Map<string, LibraryFolderRecord>
  groups: Map<string, LibraryGroupRecord>
  folderOrder: string[]
  groupOrder: string[]
  folderSettings: Record<string, unknown>
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

export function snapshotLibrary(
  state: LibraryPersistenceState,
  options: { includeSamples?: boolean } = {},
): LibraryPersistenceSnapshot {
  const samples = new Map<string, LibrarySampleRecord>()
  if (options.includeSamples !== false) {
    state.samples.forEach((sample, id) => samples.set(id, sampleRecord(sample)))
  }

  const folders = new Map<string, LibraryFolderRecord>()
  state.folders.forEach((folder, id) => folders.set(id, {
    id,
    parentId: folder.parentId,
    name: folder.name,
    path: folder.path,
    rootId: folder.rootId,
    depth: folder.depth,
    order: folder.order,
    isExpanded: state.expandedFolderIds.has(id),
    importedAt: folder.importedAt,
  }))

  const groupOrder = [...state.groupOrder]
  const groupPositions = new Map(groupOrder.map((id, index) => [id, index]))
  const groups = new Map<string, LibraryGroupRecord>()
  state.groups.forEach((group, id) => groups.set(id, {
    id,
    name: group.name,
    color: group.color,
    order: groupPositions.get(id) ?? groupOrder.length,
  }))

  return {
    samples,
    folders,
    groups,
    folderOrder: [...state.folderOrder],
    groupOrder,
    folderSettings: { ...state.folderSettings },
  }
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function changedValues<T>(previous: Map<string, T>, current: Map<string, T>): T[] {
  const changed: T[] = []
  current.forEach((value, id) => {
    if (!equal(previous.get(id), value)) changed.push(value)
  })
  return changed
}

function deletedIds<T>(previous: Map<string, T>, current: Map<string, T>): string[] {
  return [...previous.keys()].filter((id) => !current.has(id))
}

export function buildLibraryMutationBatch(
  previous: LibraryPersistenceSnapshot,
  current: LibraryPersistenceSnapshot,
): LibraryMutationBatch | null {
  const batch: LibraryMutationBatch = {
    upsertSamples: changedValues(previous.samples, current.samples),
    deleteSampleIds: deletedIds(previous.samples, current.samples),
    upsertFolders: changedValues(previous.folders, current.folders),
    deleteFolderIds: deletedIds(previous.folders, current.folders),
    upsertGroups: changedValues(previous.groups, current.groups),
    deleteGroupIds: deletedIds(previous.groups, current.groups),
  }

  if (!equal(previous.folderOrder, current.folderOrder)) batch.folderOrder = current.folderOrder
  if (!equal(previous.groupOrder, current.groupOrder)) batch.groupOrder = current.groupOrder
  if (!equal(previous.folderSettings, current.folderSettings)) batch.folderSettings = current.folderSettings

  const hasChanges = batch.upsertSamples.length > 0
    || batch.deleteSampleIds.length > 0
    || batch.upsertFolders.length > 0
    || batch.deleteFolderIds.length > 0
    || batch.upsertGroups.length > 0
    || batch.deleteGroupIds.length > 0
    || batch.folderOrder !== undefined
    || batch.groupOrder !== undefined
    || batch.folderSettings !== undefined

  return hasChanges ? batch : null
}
