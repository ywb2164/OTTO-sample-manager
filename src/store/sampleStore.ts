import { create } from 'zustand'
import { Sample, SampleGroup, SampleFolder, StructuredImportPayload } from '@/types'

function extractFolderInfo(filePath: string): {
  folderPath: string
  folderName: string
} {
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) {
    return { folderPath: '', folderName: '根目录' }
  }

  const folderPath = normalized.substring(0, lastSlash)
  const folderName = folderPath.split('/').pop() || '根目录'

  return { folderPath, folderName }
}

function collectDescendantFolderIds(folderId: string, folders: Map<string, SampleFolder>): string[] {
  const result = [folderId]
  const folder = folders.get(folderId)
  if (!folder) return result

  for (const childId of folder.childFolderIds) {
    result.push(...collectDescendantFolderIds(childId, folders))
  }

  return result
}

function collectFolderSampleIds(folderId: string, folders: Map<string, SampleFolder>): string[] {
  const folder = folders.get(folderId)
  if (!folder) return []

  const sampleIds = [...folder.sampleIds]
  for (const childId of folder.childFolderIds) {
    sampleIds.push(...collectFolderSampleIds(childId, folders))
  }

  return sampleIds
}

function getAncestorFolderIds(folderId: string, folders: Map<string, SampleFolder>): string[] {
  const ancestors: string[] = []
  let current = folders.get(folderId)

  while (current?.parentId) {
    ancestors.push(current.parentId)
    current = folders.get(current.parentId)
  }

  return ancestors
}

function createFlatFolderForSample(sample: Sample): SampleFolder {
  const { folderPath } = extractFolderInfo(sample.filePath)
  const folderId = `folder_${folderPath}`
  const { folderName } = extractFolderInfo(`${folderPath}/dummy`)

  return {
    id: folderId,
    name: folderName,
    path: folderPath,
    sampleIds: [sample.id],
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

interface SampleStore {
  samples: Map<string, Sample>
  groups: Map<string, SampleGroup>
  searchQuery: string
  activeGroupId: string | null
  selectedIds: Set<string>
  anchorId: string | null
  isImporting: boolean
  decodeProgress: { current: number; total: number } | null
  folders: Map<string, SampleFolder>
  folderOrder: string[]
  expandedFolderIds: Set<string>
  preSearchExpandedFolderIds: Set<string> | null
  folderSettings: {
    expandOnSearch: boolean
    folderClassificationEnabled: boolean
  }
  hiddenSampleIds: Set<string>
  hiddenFolderIds: Set<string>
  contextMenuTarget: {
    type: 'sample' | 'folder'
    id: string
    x: number
    y: number
  } | null
  showSelectionBar: boolean
  lastGroupChangeTimestamp: number

  addSamples: (samples: Sample[]) => void
  importStructuredData: (payload: StructuredImportPayload) => void
  restoreFolders: (folders: SampleFolder[], folderOrder: string[]) => void
  removeAllImported: () => void
  removeSamples: (ids: string[]) => void
  updateSample: (id: string, patch: Partial<Sample>) => void

  addGroup: (group: SampleGroup) => void
  removeGroup: (id: string) => void
  renameGroup: (id: string, name: string) => void
  addToGroup: (sampleIds: string[], groupId: string) => void
  removeFromGroup: (sampleIds: string[], groupId: string) => void

  setSearchQuery: (query: string) => void
  setActiveGroupId: (id: string | null) => void

  setSelected: (ids: Set<string>) => void
  toggleSelected: (id: string) => void
  selectRange: (fromId: string, toId: string, orderedIds: string[]) => void
  selectAll: () => void
  clearSelection: () => void
  setAnchorId: (id: string | null) => void

  setIsImporting: (value: boolean) => void
  setDecodeProgress: (progress: { current: number; total: number } | null) => void

  addFolder: (folder: SampleFolder) => void
  removeFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void
  toggleFolderExpanded: (id: string) => void
  setFolderExpanded: (id: string, expanded: boolean) => void
  moveFolder: (fromIndex: number, toIndex: number) => void
  setExpandOnSearch: (value: boolean) => void
  setFolderClassificationEnabled: (value: boolean) => void

  toggleSampleHidden: (sampleId: string) => void
  toggleFolderHidden: (folderId: string) => void
  unhideAll: () => void

  openContextMenu: (type: 'sample' | 'folder', id: string, x: number, y: number) => void
  closeContextMenu: () => void
  setShowSelectionBar: (show: boolean) => void

  getFilteredSamples: () => Sample[]
  getOrderedIds: () => string[]
  getFolderForSample: (sampleId: string) => SampleFolder | null
  getFlattenedItems: () => (Sample | SampleFolder)[]
  getFolderSamples: (folderId: string) => Sample[]
}

export const useSampleStore = create<SampleStore>((set, get) => ({
  samples: new Map(),
  groups: new Map(),
  searchQuery: '',
  activeGroupId: null,
  selectedIds: new Set(),
  anchorId: null,
  isImporting: false,
  decodeProgress: null,
  folders: new Map(),
  folderOrder: [],
  expandedFolderIds: new Set(),
  preSearchExpandedFolderIds: null,
  folderSettings: {
    expandOnSearch: true,
    folderClassificationEnabled: true,
  },
  hiddenSampleIds: new Set(),
  hiddenFolderIds: new Set(),
  contextMenuTarget: null,
  showSelectionBar: false,
  lastGroupChangeTimestamp: Date.now(),

  addSamples: (newSamples) => set((state) => {
    const samples = new Map(state.samples)
    const folders = new Map(state.folders)
    const folderOrder = [...state.folderOrder]
    const existingFilePaths = new Set(Array.from(samples.values()).map((sample) => sample.filePath))

    for (const incomingSample of newSamples) {
      const sample = {
        ...incomingSample,
        folderId: incomingSample.folderId ?? null,
      }

      if (existingFilePaths.has(sample.filePath)) continue

      const { folderPath } = extractFolderInfo(sample.filePath)
      const folderId = sample.folderId ?? `folder_${folderPath}`
      sample.folderId = folderId

      let folder = folders.get(folderId)
      if (!folder) {
        folder = createFlatFolderForSample(sample)
        folders.set(folderId, folder)
        if (!folderOrder.includes(folderId)) {
          folderOrder.unshift(folderId)
        }
      }

      samples.set(sample.id, sample)
      existingFilePaths.add(sample.filePath)
      if (!folder.sampleIds.includes(sample.id)) {
        folder.sampleIds.push(sample.id)
      }
    }

    return { samples, folders, folderOrder }
  }),

  importStructuredData: ({ samples: newSamples, folders: newFolders, rootFolderIds, targetGroupId }) => set((state) => {
    const samples = new Map(state.samples)
    const folders = new Map(state.folders)
    const groups = new Map(state.groups)
    const folderOrder = [...state.folderOrder]
    const importedSampleIds: string[] = []
    const existingFilePaths = new Set(Array.from(samples.values()).map((sample) => sample.filePath))

    for (const folder of newFolders) {
      folders.set(folder.id, { ...folder })
    }

    for (const incomingSample of newSamples) {
      const sample = {
        ...incomingSample,
        folderId: incomingSample.folderId ?? null,
      }

      if (existingFilePaths.has(sample.filePath)) continue

      samples.set(sample.id, sample)
      existingFilePaths.add(sample.filePath)
      importedSampleIds.push(sample.id)
    }

    for (const rootFolderId of rootFolderIds) {
      if (!folderOrder.includes(rootFolderId)) {
        folderOrder.unshift(rootFolderId)
      }
    }

    if (targetGroupId) {
      const group = groups.get(targetGroupId)
      if (group) {
        groups.set(targetGroupId, {
          ...group,
          sampleIds: [...new Set([...group.sampleIds, ...importedSampleIds])],
        })
      }
    }

    return { samples, folders, groups, folderOrder, lastGroupChangeTimestamp: Date.now() }
  }),

  restoreFolders: (folderList, folderOrder) => set(() => ({
    folders: new Map(folderList.map((folder) => [folder.id, folder])),
    folderOrder,
  })),

  removeAllImported: () => set(() => ({
    samples: new Map(),
    groups: new Map(),
    selectedIds: new Set(),
    anchorId: null,
    folders: new Map(),
    folderOrder: [],
    expandedFolderIds: new Set(),
    preSearchExpandedFolderIds: null,
    hiddenSampleIds: new Set(),
    hiddenFolderIds: new Set(),
    contextMenuTarget: null,
    showSelectionBar: false,
    activeGroupId: null,
    searchQuery: '',
    isImporting: false,
    decodeProgress: null,
    lastGroupChangeTimestamp: Date.now(),
  })),

  removeSamples: (ids) => set((state) => {
    const samples = new Map(state.samples)
    const groups = new Map(state.groups)
    const folders = new Map(state.folders)
    const selectedIds = new Set(state.selectedIds)

    for (const id of ids) {
      samples.delete(id)
      selectedIds.delete(id)
    }

    for (const [gid, group] of groups) {
      groups.set(gid, {
        ...group,
        sampleIds: group.sampleIds.filter((sid) => !ids.includes(sid)),
      })
    }

    for (const [fid, folder] of folders) {
      folders.set(fid, {
        ...folder,
        sampleIds: folder.sampleIds.filter((sid) => !ids.includes(sid)),
      })
    }

    return { samples, groups, folders, selectedIds, lastGroupChangeTimestamp: Date.now() }
  }),

  updateSample: (id, patch) => set((state) => {
    const samples = new Map(state.samples)
    const existing = samples.get(id)
    if (existing) {
      samples.set(id, { ...existing, ...patch })
    }
    return { samples }
  }),

  addGroup: (group) => set((state) => {
    const groups = new Map(state.groups)
    groups.set(group.id, group)
    return { groups, lastGroupChangeTimestamp: Date.now() }
  }),

  removeGroup: (id) => set((state) => {
    const groups = new Map(state.groups)
    const samples = new Map(state.samples)
    groups.delete(id)

    for (const [sid, sample] of samples) {
      if (sample.groupIds.includes(id)) {
        samples.set(sid, {
          ...sample,
          groupIds: sample.groupIds.filter((gid) => gid !== id),
        })
      }
    }

    return { groups, samples, lastGroupChangeTimestamp: Date.now() }
  }),

  renameGroup: (id, name) => set((state) => {
    const groups = new Map(state.groups)
    const group = groups.get(id)
    if (group) groups.set(id, { ...group, name })
    return { groups, lastGroupChangeTimestamp: Date.now() }
  }),

  addToGroup: (sampleIds, groupId) => set((state) => {
    const samples = new Map(state.samples)
    const groups = new Map(state.groups)

    for (const sid of sampleIds) {
      const sample = samples.get(sid)
      if (sample && !sample.groupIds.includes(groupId)) {
        samples.set(sid, { ...sample, groupIds: [...sample.groupIds, groupId] })
      }
    }

    const group = groups.get(groupId)
    if (group) {
      groups.set(groupId, {
        ...group,
        sampleIds: [...new Set([...group.sampleIds, ...sampleIds])],
      })
    }

    return { samples, groups, lastGroupChangeTimestamp: Date.now() }
  }),

  removeFromGroup: (sampleIds, groupId) => set((state) => {
    const samples = new Map(state.samples)
    const groups = new Map(state.groups)

    for (const sid of sampleIds) {
      const sample = samples.get(sid)
      if (sample) {
        samples.set(sid, {
          ...sample,
          groupIds: sample.groupIds.filter((group) => group !== groupId),
        })
      }
    }

    const group = groups.get(groupId)
    if (group) {
      groups.set(groupId, {
        ...group,
        sampleIds: group.sampleIds.filter((sid) => !sampleIds.includes(sid)),
      })
    }

    return { samples, groups, lastGroupChangeTimestamp: Date.now() }
  }),

  setSearchQuery: (searchQuery) => set((state) => {
    const wasEmpty = !state.searchQuery.trim()
    const isEmpty = !searchQuery.trim()

    let preSearchExpandedFolderIds = state.preSearchExpandedFolderIds
    let expandedFolderIds = new Set(state.expandedFolderIds)

    if (wasEmpty && !isEmpty) {
      preSearchExpandedFolderIds = new Set(state.expandedFolderIds)

      if (state.folderSettings.expandOnSearch) {
        const q = searchQuery.toLowerCase().trim()
        const keywords = q.split(/\s+/).filter((keyword) => keyword.length > 0)
        const matchingFolderIds = new Set<string>()

        for (const sample of state.samples.values()) {
          if (state.activeGroupId && !sample.groupIds.includes(state.activeGroupId)) {
            continue
          }

          const matches = keywords.every((keyword) => sample.fileName.toLowerCase().includes(keyword))
          if (!matches || !sample.folderId) {
            continue
          }

          matchingFolderIds.add(sample.folderId)
          for (const ancestorId of getAncestorFolderIds(sample.folderId, state.folders)) {
            matchingFolderIds.add(ancestorId)
          }
        }

        matchingFolderIds.forEach((folderId) => expandedFolderIds.add(folderId))
      }
    } else if (!wasEmpty && isEmpty && state.preSearchExpandedFolderIds) {
      expandedFolderIds = new Set(state.preSearchExpandedFolderIds)
      preSearchExpandedFolderIds = null
    }

    return {
      searchQuery,
      expandedFolderIds,
      preSearchExpandedFolderIds,
    }
  }),

  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setSelected: (selectedIds) => set({ selectedIds }),

  toggleSelected: (id) => set((state) => {
    const selectedIds = new Set(state.selectedIds)
    if (selectedIds.has(id)) {
      selectedIds.delete(id)
    } else {
      selectedIds.add(id)
    }
    return { selectedIds, anchorId: id }
  }),

  selectRange: (fromId, toId, orderedIds) => set(() => {
    const fromIndex = orderedIds.indexOf(fromId)
    const toIndex = orderedIds.indexOf(toId)
    if (fromIndex === -1 || toIndex === -1) {
      return {}
    }

    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
    return { selectedIds: new Set(orderedIds.slice(start, end + 1)) }
  }),

  selectAll: () => set(() => ({ selectedIds: new Set(get().getOrderedIds()) })),
  clearSelection: () => set({ selectedIds: new Set(), showSelectionBar: false }),
  setAnchorId: (anchorId) => set({ anchorId }),
  setIsImporting: (isImporting) => set({ isImporting }),
  setDecodeProgress: (decodeProgress) => set({ decodeProgress }),

  addFolder: (folder) => set((state) => {
    const folders = new Map(state.folders)
    folders.set(folder.id, folder)
    const folderOrder = folder.parentId ? state.folderOrder : [folder.id, ...state.folderOrder]
    return { folders, folderOrder }
  }),

  removeFolder: (id) => set((state) => {
    const folders = new Map(state.folders)
    const expandedFolderIds = new Set(state.expandedFolderIds)
    const hiddenFolderIds = new Set(state.hiddenFolderIds)
    const folder = folders.get(id)
    if (!folder) return {}

    const folderIdsToRemove = collectDescendantFolderIds(id, folders)
    let folderOrder = state.folderOrder.filter((folderId) => !folderIdsToRemove.includes(folderId))

    if (folder.parentId) {
      const parent = folders.get(folder.parentId)
      if (parent) {
        folders.set(folder.parentId, {
          ...parent,
          childFolderIds: parent.childFolderIds.filter((childId) => childId !== id),
        })
      }
    }

    for (const folderId of folderIdsToRemove) {
      folders.delete(folderId)
      expandedFolderIds.delete(folderId)
      hiddenFolderIds.delete(folderId)
    }

    folderOrder = [...folderOrder]
    return { folders, folderOrder, expandedFolderIds, hiddenFolderIds }
  }),

  renameFolder: (id, name) => set((state) => {
    const folders = new Map(state.folders)
    const folder = folders.get(id)
    if (folder) {
      folders.set(id, { ...folder, name })
    }
    return { folders }
  }),

  toggleFolderExpanded: (id) => set((state) => {
    const expandedFolderIds = new Set(state.expandedFolderIds)
    if (expandedFolderIds.has(id)) {
      expandedFolderIds.delete(id)
    } else {
      expandedFolderIds.add(id)
    }
    return { expandedFolderIds }
  }),

  setFolderExpanded: (id, expanded) => set((state) => {
    const expandedFolderIds = new Set(state.expandedFolderIds)
    if (expanded) expandedFolderIds.add(id)
    else expandedFolderIds.delete(id)
    return { expandedFolderIds }
  }),

  moveFolder: (fromIndex, toIndex) => set((state) => {
    const folderOrder = [...state.folderOrder]
    const [moved] = folderOrder.splice(fromIndex, 1)
    folderOrder.splice(toIndex, 0, moved)
    return { folderOrder }
  }),

  setExpandOnSearch: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, expandOnSearch: value },
  })),

  setFolderClassificationEnabled: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, folderClassificationEnabled: value },
  })),

  toggleSampleHidden: (sampleId) => set((state) => {
    const hiddenSampleIds = new Set(state.hiddenSampleIds)
    if (hiddenSampleIds.has(sampleId)) hiddenSampleIds.delete(sampleId)
    else hiddenSampleIds.add(sampleId)
    return { hiddenSampleIds }
  }),

  toggleFolderHidden: (folderId) => set((state) => {
    const hiddenFolderIds = new Set(state.hiddenFolderIds)
    if (hiddenFolderIds.has(folderId)) hiddenFolderIds.delete(folderId)
    else hiddenFolderIds.add(folderId)
    return { hiddenFolderIds }
  }),

  unhideAll: () => set({
    hiddenSampleIds: new Set(),
    hiddenFolderIds: new Set(),
  }),

  openContextMenu: (type, id, x, y) => set({
    contextMenuTarget: { type, id, x, y },
    showSelectionBar: true,
  }),

  closeContextMenu: () => set({ contextMenuTarget: null }),
  setShowSelectionBar: (show) => set({ showSelectionBar: show }),

  getFilteredSamples: () => {
    const { samples, searchQuery, activeGroupId, hiddenSampleIds, hiddenFolderIds, folders } = get()
    let list = [...samples.values()]

    const hiddenFolderSampleIds = new Set<string>()
    for (const folderId of hiddenFolderIds) {
      collectFolderSampleIds(folderId, folders).forEach((sampleId) => hiddenFolderSampleIds.add(sampleId))
    }

    list = list.filter((sample) => !hiddenSampleIds.has(sample.id) && !hiddenFolderSampleIds.has(sample.id))

    if (activeGroupId) {
      list = list.filter((sample) => sample.groupIds.includes(activeGroupId))
    }

    if (searchQuery.trim()) {
      const keywords = searchQuery.toLowerCase().trim().split(/\s+/).filter((keyword) => keyword.length > 0)
      list = list.filter((sample) => keywords.every((keyword) => sample.fileName.toLowerCase().includes(keyword)))
    }

    return list.sort((a, b) => a.importedAt - b.importedAt)
  },

  getOrderedIds: () => get().getFilteredSamples().map((sample) => sample.id),

  getFolderForSample: (sampleId) => {
    const { samples, folders } = get()
    const sample = samples.get(sampleId)
    if (!sample?.folderId) return null
    return folders.get(sample.folderId) ?? null
  },

  getFolderSamples: (folderId) => {
    const { folders, samples } = get()
    return collectFolderSampleIds(folderId, folders)
      .map((sampleId) => samples.get(sampleId))
      .filter((sample): sample is Sample => sample !== undefined)
  },

  getFlattenedItems: () => {
    const { folders, folderOrder, expandedFolderIds, folderSettings, hiddenFolderIds } = get()

    if (!folderSettings.folderClassificationEnabled) {
      return get()
        .getFilteredSamples()
        .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' }))
    }

    const filteredSamples = get().getFilteredSamples()
    const filteredSampleIds = new Set(filteredSamples.map((sample) => sample.id))
    const filteredSampleMap = new Map(filteredSamples.map((sample) => [sample.id, sample]))
    const items: (Sample | SampleFolder)[] = []

    const appendFolderTree = (folderId: string) => {
      if (hiddenFolderIds.has(folderId)) return

      const folder = folders.get(folderId)
      if (!folder) return

      const folderSampleIds = collectFolderSampleIds(folderId, folders).filter((sampleId) => filteredSampleIds.has(sampleId))
      if (folderSampleIds.length === 0) return

      items.push(folder)

      if (!expandedFolderIds.has(folderId)) return

      const childFolders = folder.childFolderIds
        .map((childId) => folders.get(childId))
        .filter((child): child is SampleFolder => child !== undefined)
        .sort((a, b) => a.importedAt - b.importedAt)

      for (const childFolder of childFolders) {
        appendFolderTree(childFolder.id)
      }

      const directSamples = folder.sampleIds
        .map((sampleId) => filteredSampleMap.get(sampleId))
        .filter((sample): sample is Sample => sample !== undefined)
        .sort((a, b) => a.importedAt - b.importedAt)

      items.push(...directSamples)
    }

    for (const rootFolderId of folderOrder) {
      appendFolderTree(rootFolderId)
    }

    const attachedSampleIds = new Set<string>()
    folders.forEach((folder) => {
      collectFolderSampleIds(folder.id, folders).forEach((sampleId) => attachedSampleIds.add(sampleId))
    })

    const orphanSamples = filteredSamples
      .filter((sample) => !attachedSampleIds.has(sample.id))
      .sort((a, b) => a.importedAt - b.importedAt)

    items.push(...orphanSamples)
    return items
  },
}))
