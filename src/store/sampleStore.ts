import { create } from 'zustand'
import { Sample, SampleGroup, SampleFolder, StructuredImportPayload } from '@/types'
import {
  compareSampleSearchMatches,
  getSampleSearchIndexMap,
  matchSampleSearch,
  parseSearchQuery,
} from '@/utils/sampleSearch'

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

type FolderDerivedCache = {
  foldersRef: Map<string, SampleFolder> | null
  descendantSampleIdsByFolder: Map<string, string[]>
  descendantFolderIdsByFolder: Map<string, string[]>
}

type FilteredSamplesCache = {
  samplesRef: Map<string, Sample> | null
  foldersRef: Map<string, SampleFolder> | null
  groupsRef: Map<string, SampleGroup> | null
  hiddenSampleIdsRef: Set<string> | null
  hiddenFolderIdsRef: Set<string> | null
  searchQuery: string
  enableChinesePinyinFuzzySearch: boolean
  activeGroupId: string | null
  lastGroupChangeTimestamp: number
  result: Sample[]
}

type FlattenedItemsCache = {
  filteredSamplesRef: Sample[] | null
  foldersRef: Map<string, SampleFolder> | null
  folderOrderRef: string[] | null
  expandedFolderIdsRef: Set<string> | null
  hiddenFolderIdsRef: Set<string> | null
  folderClassificationEnabled: boolean | null
  result: (Sample | SampleFolder)[]
}

type OrderedIdsCache = {
  filteredSamplesRef: Sample[] | null
  result: string[]
}

type FolderSelectionCache = {
  selectedIdsRef: Set<string> | null
  foldersRef: Map<string, SampleFolder> | null
  selectedCountByFolder: Map<string, number>
}

const folderDerivedCache: FolderDerivedCache = {
  foldersRef: null,
  descendantSampleIdsByFolder: new Map(),
  descendantFolderIdsByFolder: new Map(),
}

const filteredSamplesCache: FilteredSamplesCache = {
  samplesRef: null,
  foldersRef: null,
  groupsRef: null,
  hiddenSampleIdsRef: null,
  hiddenFolderIdsRef: null,
  searchQuery: '',
  enableChinesePinyinFuzzySearch: false,
  activeGroupId: null,
  lastGroupChangeTimestamp: 0,
  result: [],
}

const flattenedItemsCache: FlattenedItemsCache = {
  filteredSamplesRef: null,
  foldersRef: null,
  folderOrderRef: null,
  expandedFolderIdsRef: null,
  hiddenFolderIdsRef: null,
  folderClassificationEnabled: null,
  result: [],
}

const orderedIdsCache: OrderedIdsCache = {
  filteredSamplesRef: null,
  result: [],
}

const folderSelectionCache: FolderSelectionCache = {
  selectedIdsRef: null,
  foldersRef: null,
  selectedCountByFolder: new Map(),
}

function getFolderDerivedData(folders: Map<string, SampleFolder>) {
  if (folderDerivedCache.foldersRef === folders) {
    return folderDerivedCache
  }

  const descendantSampleIdsByFolder = new Map<string, string[]>()
  const descendantFolderIdsByFolder = new Map<string, string[]>()

  const visit = (folderId: string): string[] => {
    const folder = folders.get(folderId)
    if (!folder) {
      descendantSampleIdsByFolder.set(folderId, [])
      descendantFolderIdsByFolder.set(folderId, [folderId])
      return []
    }

    const sampleIds = [...folder.sampleIds]
    const descendantFolderIds = [folderId]

    for (const childId of folder.childFolderIds) {
      descendantFolderIds.push(...(descendantFolderIdsByFolder.get(childId) ?? [childId]))
      sampleIds.push(...visit(childId))
      const childFolderIds = descendantFolderIdsByFolder.get(childId)
      if (childFolderIds) {
        descendantFolderIds.push(...childFolderIds.filter((id) => id !== childId))
      }
    }

    descendantSampleIdsByFolder.set(folderId, sampleIds)
    descendantFolderIdsByFolder.set(folderId, Array.from(new Set(descendantFolderIds)))
    return sampleIds
  }

  const rootFolderIds = [...folders.values()]
    .filter((folder) => folder.parentId === null)
    .map((folder) => folder.id)

  rootFolderIds.forEach((folderId) => {
    visit(folderId)
  })

  folders.forEach((folder, folderId) => {
    if (!descendantSampleIdsByFolder.has(folderId)) {
      visit(folderId)
    }
  })

  folderDerivedCache.foldersRef = folders
  folderDerivedCache.descendantSampleIdsByFolder = descendantSampleIdsByFolder
  folderDerivedCache.descendantFolderIdsByFolder = descendantFolderIdsByFolder

  return folderDerivedCache
}

function getFilteredSamplesCached(state: Pick<SampleStore,
  'samples' | 'folders' | 'groups' | 'searchQuery' | 'activeGroupId' | 'hiddenSampleIds' | 'hiddenFolderIds' | 'lastGroupChangeTimestamp' | 'folderSettings'
>): Sample[] {
  if (
    filteredSamplesCache.samplesRef === state.samples &&
    filteredSamplesCache.foldersRef === state.folders &&
    filteredSamplesCache.groupsRef === state.groups &&
    filteredSamplesCache.hiddenSampleIdsRef === state.hiddenSampleIds &&
    filteredSamplesCache.hiddenFolderIdsRef === state.hiddenFolderIds &&
    filteredSamplesCache.searchQuery === state.searchQuery &&
    filteredSamplesCache.enableChinesePinyinFuzzySearch === state.folderSettings.enableChinesePinyinFuzzySearch &&
    filteredSamplesCache.activeGroupId === state.activeGroupId &&
    filteredSamplesCache.lastGroupChangeTimestamp === state.lastGroupChangeTimestamp
  ) {
    return filteredSamplesCache.result
  }

  const { descendantSampleIdsByFolder } = getFolderDerivedData(state.folders)
  const hiddenFolderSampleIds = new Set<string>()

  for (const folderId of state.hiddenFolderIds) {
    const sampleIds = descendantSampleIdsByFolder.get(folderId) ?? []
    sampleIds.forEach((sampleId) => hiddenFolderSampleIds.add(sampleId))
  }

  let list = [...state.samples.values()]
  list = list.filter((sample) => !state.hiddenSampleIds.has(sample.id) && !hiddenFolderSampleIds.has(sample.id))

  if (state.activeGroupId) {
    list = list.filter((sample) => sample.groupIds.includes(state.activeGroupId as string))
  }

  if (state.searchQuery.trim()) {
    const keywords = parseSearchQuery(state.searchQuery)
    const searchIndexMap = getSampleSearchIndexMap(state.samples)
    const searchOptions = {
      enableChinesePinyinFuzzySearch: state.folderSettings.enableChinesePinyinFuzzySearch,
    }

    const matchedEntries = list
      .map((sample) => {
        const searchIndex = searchIndexMap.get(sample.id)
        if (!searchIndex) return null

        const match = matchSampleSearch(searchIndex, keywords, searchOptions)
        if (!match) return null

        return { sample, match }
      })
      .filter((entry): entry is { sample: Sample; match: NonNullable<ReturnType<typeof matchSampleSearch>> } => entry !== null)

    matchedEntries.sort((left, right) =>
      compareSampleSearchMatches(left.sample, left.match, right.sample, right.match),
    )

    list = matchedEntries.map((entry) => entry.sample)
  } else {
    list.sort((a, b) => a.importedAt - b.importedAt)
  }

  filteredSamplesCache.samplesRef = state.samples
  filteredSamplesCache.foldersRef = state.folders
  filteredSamplesCache.groupsRef = state.groups
  filteredSamplesCache.hiddenSampleIdsRef = state.hiddenSampleIds
  filteredSamplesCache.hiddenFolderIdsRef = state.hiddenFolderIds
  filteredSamplesCache.searchQuery = state.searchQuery
  filteredSamplesCache.enableChinesePinyinFuzzySearch = state.folderSettings.enableChinesePinyinFuzzySearch
  filteredSamplesCache.activeGroupId = state.activeGroupId
  filteredSamplesCache.lastGroupChangeTimestamp = state.lastGroupChangeTimestamp
  filteredSamplesCache.result = list

  return list
}

function getOrderedIdsCached(filteredSamples: Sample[]): string[] {
  if (orderedIdsCache.filteredSamplesRef === filteredSamples) {
    return orderedIdsCache.result
  }

  const result = filteredSamples.map((sample) => sample.id)
  orderedIdsCache.filteredSamplesRef = filteredSamples
  orderedIdsCache.result = result
  return result
}

function getFolderSelectedCountCached(
  selectedIds: Set<string>,
  folders: Map<string, SampleFolder>,
  folderId: string,
): number {
  if (
    folderSelectionCache.selectedIdsRef !== selectedIds ||
    folderSelectionCache.foldersRef !== folders
  ) {
    const { descendantSampleIdsByFolder } = getFolderDerivedData(folders)
    const selectedCountByFolder = new Map<string, number>()

    descendantSampleIdsByFolder.forEach((sampleIds, currentFolderId) => {
      let count = 0
      for (const sampleId of sampleIds) {
        if (selectedIds.has(sampleId)) {
          count += 1
        }
      }
      selectedCountByFolder.set(currentFolderId, count)
    })

    folderSelectionCache.selectedIdsRef = selectedIds
    folderSelectionCache.foldersRef = folders
    folderSelectionCache.selectedCountByFolder = selectedCountByFolder
  }

  return folderSelectionCache.selectedCountByFolder.get(folderId) ?? 0
}

function getFlattenedItemsCached(state: Pick<SampleStore,
  'folders' | 'folderOrder' | 'expandedFolderIds' | 'folderSettings' | 'hiddenFolderIds'
>, filteredSamples: Sample[]): (Sample | SampleFolder)[] {
  if (
    flattenedItemsCache.filteredSamplesRef === filteredSamples &&
    flattenedItemsCache.foldersRef === state.folders &&
    flattenedItemsCache.folderOrderRef === state.folderOrder &&
    flattenedItemsCache.expandedFolderIdsRef === state.expandedFolderIds &&
    flattenedItemsCache.hiddenFolderIdsRef === state.hiddenFolderIds &&
    flattenedItemsCache.folderClassificationEnabled === state.folderSettings.folderClassificationEnabled
  ) {
    return flattenedItemsCache.result
  }

  if (!state.folderSettings.folderClassificationEnabled) {
    const result = [...filteredSamples].sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' }))
    flattenedItemsCache.filteredSamplesRef = filteredSamples
    flattenedItemsCache.foldersRef = state.folders
    flattenedItemsCache.folderOrderRef = state.folderOrder
    flattenedItemsCache.expandedFolderIdsRef = state.expandedFolderIds
    flattenedItemsCache.hiddenFolderIdsRef = state.hiddenFolderIds
    flattenedItemsCache.folderClassificationEnabled = state.folderSettings.folderClassificationEnabled
    flattenedItemsCache.result = result
    return result
  }

  const { descendantSampleIdsByFolder } = getFolderDerivedData(state.folders)
  const filteredSampleIds = new Set(filteredSamples.map((sample) => sample.id))
  const filteredSampleMap = new Map(filteredSamples.map((sample) => [sample.id, sample]))
  const items: (Sample | SampleFolder)[] = []

  const appendFolderTree = (folderId: string) => {
    if (state.hiddenFolderIds.has(folderId)) return

    const folder = state.folders.get(folderId)
    if (!folder) return

    const subtreeSampleIds = descendantSampleIdsByFolder.get(folderId) ?? []
    const hasVisibleSample = subtreeSampleIds.some((sampleId) => filteredSampleIds.has(sampleId))
    if (!hasVisibleSample) return

    items.push(folder)

    if (!state.expandedFolderIds.has(folderId)) return

    const childFolders = folder.childFolderIds
      .map((childId) => state.folders.get(childId))
      .filter((child): child is SampleFolder => child !== undefined)
      .sort((a, b) => a.importedAt - b.importedAt)

    childFolders.forEach((childFolder) => appendFolderTree(childFolder.id))

    const directSamples = folder.sampleIds
      .map((sampleId) => filteredSampleMap.get(sampleId))
      .filter((sample): sample is Sample => sample !== undefined)
      .sort((a, b) => a.importedAt - b.importedAt)

    items.push(...directSamples)
  }

  state.folderOrder.forEach((rootFolderId) => appendFolderTree(rootFolderId))

  const attachedSampleIds = new Set<string>()
  descendantSampleIdsByFolder.forEach((sampleIds) => sampleIds.forEach((sampleId) => attachedSampleIds.add(sampleId)))

  const orphanSamples = filteredSamples
    .filter((sample) => !attachedSampleIds.has(sample.id))
    .sort((a, b) => a.importedAt - b.importedAt)

  items.push(...orphanSamples)

  flattenedItemsCache.filteredSamplesRef = filteredSamples
  flattenedItemsCache.foldersRef = state.folders
  flattenedItemsCache.folderOrderRef = state.folderOrder
  flattenedItemsCache.expandedFolderIdsRef = state.expandedFolderIds
  flattenedItemsCache.hiddenFolderIdsRef = state.hiddenFolderIds
  flattenedItemsCache.folderClassificationEnabled = state.folderSettings.folderClassificationEnabled
  flattenedItemsCache.result = items

  return items
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
    memoryOptimizationMode: boolean
    enableChinesePinyinFuzzySearch: boolean
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
  setMemoryOptimizationMode: (value: boolean) => void
  setEnableChinesePinyinFuzzySearch: (value: boolean) => void

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
  getFolderSampleIds: (folderId: string) => string[]
  getFolderSampleCount: (folderId: string) => number
  getFolderSelectedCount: (folderId: string) => number
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
    memoryOptimizationMode: false,
    enableChinesePinyinFuzzySearch: false,
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
        const keywords = parseSearchQuery(searchQuery)
        const searchIndexMap = getSampleSearchIndexMap(state.samples)
        const matchingFolderIds = new Set<string>()

        for (const sample of state.samples.values()) {
          if (state.activeGroupId && !sample.groupIds.includes(state.activeGroupId)) {
            continue
          }

          const searchIndex = searchIndexMap.get(sample.id)
          if (!searchIndex || !sample.folderId) {
            continue
          }

          const matches = matchSampleSearch(searchIndex, keywords, {
            enableChinesePinyinFuzzySearch: state.folderSettings.enableChinesePinyinFuzzySearch,
          })

          if (!matches) {
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

  setMemoryOptimizationMode: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, memoryOptimizationMode: value },
  })),

  setEnableChinesePinyinFuzzySearch: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, enableChinesePinyinFuzzySearch: value },
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
    const state = get()
    return getFilteredSamplesCached(state)
  },

  getOrderedIds: () => getOrderedIdsCached(get().getFilteredSamples()),

  getFolderForSample: (sampleId) => {
    const { samples, folders } = get()
    const sample = samples.get(sampleId)
    if (!sample?.folderId) return null
    return folders.get(sample.folderId) ?? null
  },

  getFolderSamples: (folderId) => {
    const { folders, samples } = get()
    const { descendantSampleIdsByFolder } = getFolderDerivedData(folders)
    return (descendantSampleIdsByFolder.get(folderId) ?? [])
      .map((sampleId) => samples.get(sampleId))
      .filter((sample): sample is Sample => sample !== undefined)
  },

  getFolderSampleIds: (folderId) => {
    const { folders } = get()
    const { descendantSampleIdsByFolder } = getFolderDerivedData(folders)
    return descendantSampleIdsByFolder.get(folderId) ?? []
  },

  getFolderSampleCount: (folderId) => {
    const { folders } = get()
    const { descendantSampleIdsByFolder } = getFolderDerivedData(folders)
    return descendantSampleIdsByFolder.get(folderId)?.length ?? 0
  },

  getFolderSelectedCount: (folderId) => {
    const { selectedIds, folders } = get()
    return getFolderSelectedCountCached(selectedIds, folders, folderId)
  },

  getFlattenedItems: () => {
    const state = get()
    const filteredSamples = state.getFilteredSamples()
    return getFlattenedItemsCached(state, filteredSamples)
  },
}))
