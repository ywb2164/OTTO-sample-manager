import type {
  CommitImportPayload,
  ImportFailure,
  ImportSummary,
  Sample,
  SampleFolder,
  SampleGroup,
} from '@/types'

export interface LibraryState {
  samples: Map<string, Sample>
  groups: Map<string, SampleGroup>
  folders: Map<string, SampleFolder>
  folderOrder: string[]
}

export interface LibraryImportResult {
  state: LibraryState
  summary: ImportSummary
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function cloneSample(sample: Sample): Sample {
  return { ...sample, groupIds: [...sample.groupIds] }
}

function cloneGroup(group: SampleGroup): SampleGroup {
  return { ...group, sampleIds: [...group.sampleIds] }
}

function cloneFolder(folder: SampleFolder): SampleFolder {
  return {
    ...folder,
    sampleIds: [...folder.sampleIds],
    childFolderIds: [...folder.childFolderIds],
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function pathKey(filePath: string): string {
  return normalizePath(filePath).toLowerCase()
}

function getFolderPath(filePath: string): string {
  const normalized = normalizePath(filePath)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === -1 ? '' : normalized.slice(0, lastSlash)
}

function createFlatFolder(sample: Sample): SampleFolder {
  const folderPath = getFolderPath(sample.filePath)
  const folderId = `folder_${folderPath}`

  return {
    id: folderId,
    name: folderPath.split('/').pop() || '根目录',
    path: folderPath,
    sampleIds: [],
    childFolderIds: [],
    parentId: null,
    rootId: folderId,
    depth: 0,
    importedAt: sample.importedAt,
    isExpanded: false,
    order: 0,
    isRenaming: false,
  }
}

function mergeFolder(existing: SampleFolder | undefined, incoming: SampleFolder): SampleFolder {
  if (!existing) {
    return { ...cloneFolder(incoming), sampleIds: [] }
  }

  return {
    ...incoming,
    name: existing.name,
    importedAt: existing.importedAt,
    isExpanded: existing.isExpanded,
    order: existing.order,
    isRenaming: existing.isRenaming,
    sampleIds: [],
    childFolderIds: unique([...existing.childFolderIds, ...incoming.childFolderIds]),
  }
}

function rebuildFolderMembership(
  samples: Map<string, Sample>,
  folders: Map<string, SampleFolder>,
): { samples: Map<string, Sample>; folders: Map<string, SampleFolder> } {
  const nextSamples = new Map<string, Sample>()
  const nextFolders = new Map<string, SampleFolder>()

  folders.forEach((folder, folderId) => {
    nextFolders.set(folderId, { ...cloneFolder(folder), sampleIds: [] })
  })

  samples.forEach((sourceSample, sampleId) => {
    const sample = cloneSample(sourceSample)
    let folderId = sample.folderId ?? null

    if (!folderId || !nextFolders.has(folderId)) {
      const flatFolder = createFlatFolder(sample)
      folderId = flatFolder.id
      if (!nextFolders.has(folderId)) {
        nextFolders.set(folderId, flatFolder)
      }
      sample.folderId = folderId
    }

    const folder = nextFolders.get(folderId)
    if (folder && !folder.sampleIds.includes(sampleId)) {
      folder.sampleIds.push(sampleId)
    }
    nextSamples.set(sampleId, sample)
  })

  return { samples: nextSamples, folders: nextFolders }
}

export function commitLibraryImport(
  current: LibraryState,
  payload: CommitImportPayload,
): LibraryImportResult {
  const samples = new Map(Array.from(current.samples, ([id, sample]) => [id, cloneSample(sample)]))
  const groups = new Map(Array.from(current.groups, ([id, group]) => [id, cloneGroup(group)]))
  const folders = new Map(Array.from(current.folders, ([id, folder]) => [id, cloneFolder(folder)]))
  const failures: ImportFailure[] = payload.failures.map((failure) => ({ ...failure }))
  const validTargetGroupId = payload.targetGroupId && groups.has(payload.targetGroupId)
    ? payload.targetGroupId
    : null

  if (payload.targetGroupId && !validTargetGroupId) {
    failures.push({
      path: payload.targetGroupId,
      stage: 'commit',
      reason: '目标分组不存在，素材已导入到未分组状态',
    })
  }

  payload.folders.forEach((incoming) => {
    folders.set(incoming.id, mergeFolder(folders.get(incoming.id), incoming))
  })

  const existingByPath = new Map<string, Sample>()
  samples.forEach((sample) => existingByPath.set(pathKey(sample.filePath), sample))

  let added = 0
  let linkedToGroup = 0
  let skipped = 0

  for (const candidate of payload.candidates) {
    const existing = existingByPath.get(pathKey(candidate.filePath))

    if (existing) {
      if (!existing.folderId && candidate.folderId && folders.has(candidate.folderId)) {
        existing.folderId = candidate.folderId
        samples.set(existing.id, existing)
      }

      if (validTargetGroupId) {
        const group = groups.get(validTargetGroupId)!
        const sampleHasGroup = existing.groupIds.includes(validTargetGroupId)
        const groupHasSample = group.sampleIds.includes(existing.id)

        if (!sampleHasGroup || !groupHasSample) {
          if (!sampleHasGroup) existing.groupIds.push(validTargetGroupId)
          if (!groupHasSample) group.sampleIds.push(existing.id)
          samples.set(existing.id, existing)
          groups.set(validTargetGroupId, group)
          linkedToGroup += 1
        } else {
          skipped += 1
        }
      } else {
        skipped += 1
      }
      continue
    }

    const sample: Sample = {
      ...candidate,
      folderId: candidate.folderId ?? null,
      groupIds: validTargetGroupId ? [validTargetGroupId] : [],
    }
    samples.set(sample.id, sample)
    existingByPath.set(pathKey(sample.filePath), sample)
    added += 1

    if (validTargetGroupId) {
      const group = groups.get(validTargetGroupId)!
      if (!group.sampleIds.includes(sample.id)) group.sampleIds.push(sample.id)
      groups.set(validTargetGroupId, group)
    }
  }

  const rebuilt = rebuildFolderMembership(samples, folders)
  const existingRootOrder = current.folderOrder.filter((folderId) => rebuilt.folders.has(folderId))
  const importedRootIds = payload.candidates.length > 0
    ? payload.rootFolderIds.filter((folderId) => rebuilt.folders.has(folderId))
    : []
  const folderOrder = unique([
    ...importedRootIds.filter((folderId) => !existingRootOrder.includes(folderId)),
    ...existingRootOrder,
    ...Array.from(rebuilt.folders.values())
      .filter((folder) => folder.parentId === null)
      .map((folder) => folder.id),
  ])

  return {
    state: {
      samples: rebuilt.samples,
      groups,
      folders: rebuilt.folders,
      folderOrder,
    },
    summary: {
      scanned: payload.scannedFileCount,
      added,
      linkedToGroup,
      skipped,
      failed: failures.length,
      targetGroupId: validTargetGroupId,
      failures,
    },
  }
}

export function reconcileLibraryState(current: LibraryState): LibraryState {
  const samples = new Map(Array.from(current.samples, ([id, sample]) => [id, cloneSample(sample)]))
  const groups = new Map(Array.from(current.groups, ([id, group]) => [id, cloneGroup(group)]))
  const folders = new Map(Array.from(current.folders, ([id, folder]) => [id, cloneFolder(folder)]))

  const sampleGroupMemberships = new Map<string, Set<string>>()
  samples.forEach((_sample, sampleId) => sampleGroupMemberships.set(sampleId, new Set()))

  groups.forEach((group, groupId) => {
    group.sampleIds.forEach((sampleId) => {
      if (samples.has(sampleId)) sampleGroupMemberships.get(sampleId)?.add(groupId)
    })
  })
  samples.forEach((sample, sampleId) => {
    sample.groupIds.forEach((groupId) => {
      if (groups.has(groupId)) sampleGroupMemberships.get(sampleId)?.add(groupId)
    })
  })

  samples.forEach((sample, sampleId) => {
    sample.groupIds = Array.from(sampleGroupMemberships.get(sampleId) ?? [])
    samples.set(sampleId, sample)
  })
  groups.forEach((group, groupId) => {
    group.sampleIds = Array.from(samples.values())
      .filter((sample) => sample.groupIds.includes(groupId))
      .map((sample) => sample.id)
    groups.set(groupId, group)
  })

  folders.forEach((folder, folderId) => {
    const parentExists = folder.parentId ? folders.has(folder.parentId) : true
    folders.set(folderId, {
      ...folder,
      parentId: parentExists ? folder.parentId : null,
      rootId: parentExists ? folder.rootId : folder.id,
      depth: parentExists ? folder.depth : 0,
      childFolderIds: unique(folder.childFolderIds.filter((childId) => folders.has(childId))),
    })
  })
  folders.forEach((folder) => {
    if (!folder.parentId) return
    const parent = folders.get(folder.parentId)
    if (parent && !parent.childFolderIds.includes(folder.id)) {
      parent.childFolderIds.push(folder.id)
      folders.set(parent.id, parent)
    }
  })

  const rebuilt = rebuildFolderMembership(samples, folders)
  const rootIds = Array.from(rebuilt.folders.values())
    .filter((folder) => folder.parentId === null)
    .map((folder) => folder.id)

  return {
    samples: rebuilt.samples,
    groups,
    folders: rebuilt.folders,
    folderOrder: unique([
      ...current.folderOrder.filter((folderId) => rootIds.includes(folderId)),
      ...rootIds,
    ]),
  }
}
