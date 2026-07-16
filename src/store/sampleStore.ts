import { create } from 'zustand'
import type {
  CommitImportPayload,
  ImportSummary,
  ImportUndoReceipt,
  Sample,
  SampleFolder,
  SampleGroup,
  SampleListEntry,
  SampleSummary,
  StoredImportUndoState,
  UndoImportSummary,
} from '@/types'
import {
  commitLibraryImport,
  isImportUndoReceiptApplicable,
  undoLibraryImport,
} from '@/services/libraryImport'
import { audioRuntimeCache } from '@/services/audioRuntimeCache'
import {
  persistPagedSample,
  persistPagedSampleDeletes,
  persistPagedSampleGroups,
} from '@/services/pagedLibraryPersistence'

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

function reconcileGroupOrder(groupOrder: string[] | null | undefined, groups: Map<string, SampleGroup>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const groupId of groupOrder ?? []) {
    if (groups.has(groupId) && !seen.has(groupId)) {
      seen.add(groupId)
      result.push(groupId)
    }
  }

  for (const groupId of groups.keys()) {
    if (!seen.has(groupId)) {
      seen.add(groupId)
      result.push(groupId)
    }
  }

  return result
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
  sampleSummariesRef: Map<string, SampleSummary> | null
  foldersRef: Map<string, SampleFolder> | null
  groupsRef: Map<string, SampleGroup> | null
  hiddenSampleIdsRef: Set<string> | null
  hiddenFolderIdsRef: Set<string> | null
  searchQuery: string
  enableChinesePinyinFuzzySearch: boolean
  activeGroupId: string | null
  searchResultIdsRef: string[] | null
  lastGroupChangeTimestamp: number
  result: SampleListEntry[]
}

type FlattenedItemsCache = {
  filteredSamplesRef: SampleListEntry[] | null
  foldersRef: Map<string, SampleFolder> | null
  folderOrderRef: string[] | null
  expandedFolderIdsRef: Set<string> | null
  hiddenFolderIdsRef: Set<string> | null
  folderClassificationEnabled: boolean | null
  result: (SampleListEntry | SampleFolder)[]
}

type OrderedIdsCache = {
  filteredSamplesRef: SampleListEntry[] | null
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
  sampleSummariesRef: null,
  foldersRef: null,
  groupsRef: null,
  hiddenSampleIdsRef: null,
  hiddenFolderIdsRef: null,
  searchQuery: '',
  enableChinesePinyinFuzzySearch: false,
  activeGroupId: null,
  searchResultIdsRef: null,
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

  folders.forEach((_folder, folderId) => {
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
  'samples' | 'sampleSummaries' | 'pagedLibrary' | 'folders' | 'groups' | 'searchQuery' | 'searchResultIds' | 'activeGroupId' | 'hiddenSampleIds' | 'hiddenFolderIds' | 'lastGroupChangeTimestamp' | 'folderSettings'
>): SampleListEntry[] {
  if (
    filteredSamplesCache.samplesRef === state.samples &&
    filteredSamplesCache.sampleSummariesRef === state.sampleSummaries &&
    filteredSamplesCache.foldersRef === state.folders &&
    filteredSamplesCache.groupsRef === state.groups &&
    filteredSamplesCache.hiddenSampleIdsRef === state.hiddenSampleIds &&
    filteredSamplesCache.hiddenFolderIdsRef === state.hiddenFolderIds &&
    filteredSamplesCache.searchQuery === state.searchQuery &&
    filteredSamplesCache.enableChinesePinyinFuzzySearch === state.folderSettings.enableChinesePinyinFuzzySearch &&
    filteredSamplesCache.activeGroupId === state.activeGroupId &&
    filteredSamplesCache.searchResultIdsRef === state.searchResultIds &&
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

  let list: SampleListEntry[] = state.pagedLibrary
    ? [...state.sampleSummaries.values()].map((summary) => state.samples.get(summary.id) ?? summary)
    : [...state.samples.values()]
  list = list.filter((sample) => !state.hiddenSampleIds.has(sample.id) && !hiddenFolderSampleIds.has(sample.id))

  if (state.activeGroupId) {
    list = list.filter((sample) => sample.groupIds.includes(state.activeGroupId as string))
  }

  if (state.searchQuery.trim()) {
    const visibleById = new Map(list.map((sample) => [sample.id, sample]))
    list = (state.searchResultIds ?? [])
      .map((sampleId) => visibleById.get(sampleId))
      .filter((sample): sample is Sample => sample !== undefined)
  } else {
    list.sort((a, b) => a.importedAt - b.importedAt)
  }

  filteredSamplesCache.samplesRef = state.samples
  filteredSamplesCache.sampleSummariesRef = state.sampleSummaries
  filteredSamplesCache.foldersRef = state.folders
  filteredSamplesCache.groupsRef = state.groups
  filteredSamplesCache.hiddenSampleIdsRef = state.hiddenSampleIds
  filteredSamplesCache.hiddenFolderIdsRef = state.hiddenFolderIds
  filteredSamplesCache.searchQuery = state.searchQuery
  filteredSamplesCache.enableChinesePinyinFuzzySearch = state.folderSettings.enableChinesePinyinFuzzySearch
  filteredSamplesCache.activeGroupId = state.activeGroupId
  filteredSamplesCache.searchResultIdsRef = state.searchResultIds
  filteredSamplesCache.lastGroupChangeTimestamp = state.lastGroupChangeTimestamp
  filteredSamplesCache.result = list

  return list
}

function getOrderedIdsCached(filteredSamples: SampleListEntry[]): string[] {
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
>, filteredSamples: SampleListEntry[]): (SampleListEntry | SampleFolder)[] {
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
  const items: (SampleListEntry | SampleFolder)[] = []

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
      .filter((sample): sample is SampleListEntry => sample !== undefined)
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
  sampleSummaries: Map<string, SampleSummary>
  pagedLibrary: boolean
  groups: Map<string, SampleGroup>
  groupOrder: string[]
  searchQuery: string
  searchResultIds: string[] | null
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
    type: 'sample' | 'folder' | 'background'
    id: string
    x: number
    y: number
  } | null
  showSelectionBar: boolean
  lastGroupChangeTimestamp: number
  libraryRevision: number
  persistenceVersion: number
  lastImportUndo: ImportUndoReceipt | null
  lastUndoSummary: UndoImportSummary | null

  addSamples: (samples: Sample[]) => void
  setPagedLibrary: (summaries: SampleSummary[], samples: Sample[]) => void
  replaceCachedSamples: (samples: Sample[]) => void
  commitImport: (payload: CommitImportPayload) => ImportSummary
  undoLastImport: () => UndoImportSummary | null
  invalidateLastImportUndo: () => void
  restoreImportUndoState: (state: StoredImportUndoState | null | undefined) => void
  clearUndoSummary: () => void
  restoreFolders: (folders: SampleFolder[], folderOrder: string[]) => void
  removeAllImported: () => void
  removeSamples: (ids: string[]) => void
  updateSample: (id: string, patch: Partial<Sample>) => void

  addGroup: (group: SampleGroup) => void
  removeGroup: (id: string) => void
  renameGroup: (id: string, name: string) => void
  moveGroup: (draggedGroupId: string, targetGroupId: string) => void
  restoreGroupOrder: (groupOrder: string[] | null | undefined, groups?: Map<string, SampleGroup>) => void
  addToGroup: (sampleIds: string[], groupId: string) => void
  removeFromGroup: (sampleIds: string[], groupId: string) => void

  setSearchQuery: (query: string) => void
  setSearchResults: (ids: string[], ancestorFolderIds: string[]) => void
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

  openContextMenu: (type: 'sample' | 'folder' | 'background', id: string, x: number, y: number) => void
  closeContextMenu: () => void
  setShowSelectionBar: (show: boolean) => void

  getFilteredSamples: () => SampleListEntry[]
  getOrderedIds: () => string[]
  getFolderForSample: (sampleId: string) => SampleFolder | null
  getFlattenedItems: () => (SampleListEntry | SampleFolder)[]
  getFolderSamples: (folderId: string) => Sample[]
  getFolderSampleIds: (folderId: string) => string[]
  getFolderSampleCount: (folderId: string) => number
  getFolderSelectedCount: (folderId: string) => number
}

export const useSampleStore = create<SampleStore>((set, get) => ({
  samples: new Map(),
  sampleSummaries: new Map(),
  pagedLibrary: false,
  groups: new Map(),
  groupOrder: [],
  searchQuery: '',
  searchResultIds: null,
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
  libraryRevision: 0,
  persistenceVersion: 0,
  lastImportUndo: null,
  lastUndoSummary: null,

  setPagedLibrary: (summaries, cachedSamples) => set(() => ({
    pagedLibrary: true,
    sampleSummaries: new Map(summaries.map((summary) => [summary.id, summary])),
    samples: new Map(cachedSamples.map((sample) => [sample.id, sample])),
  })),

  replaceCachedSamples: (cachedSamples) => set((state) => {
    const samples = new Map<string, Sample>()
    for (const sample of cachedSamples) {
      const current = state.samples.get(sample.id)
      samples.set(sample.id, current ? {
        ...sample,
        waveformData: current.waveformData,
        isDecoded: current.isDecoded,
      } : sample)
    }
    return { samples }
  }),

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

    if (samples.size === state.samples.size) return {}
    return {
      samples,
      folders,
      folderOrder,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
    }
  }),

  commitImport: (payload) => {
    let summary: ImportSummary | null = null

    set((state) => {
      const result = commitLibraryImport({
        samples: state.samples,
        groups: state.groups,
        folders: state.folders,
        folderOrder: state.folderOrder,
      }, payload)
      summary = result.summary

      if (!result.undoReceipt) {
        return {
          ...result.state,
          lastGroupChangeTimestamp: Date.now(),
        }
      }

      const libraryRevision = state.libraryRevision + 1

      return {
        ...result.state,
        libraryRevision,
        lastImportUndo: {
          ...result.undoReceipt,
          expectedLibraryRevision: libraryRevision,
        },
        lastUndoSummary: null,
        lastGroupChangeTimestamp: Date.now(),
      }
    })

    if (!summary) {
      throw new Error('导入事务未能生成结果')
    }
    return summary
  },

  undoLastImport: () => {
    let summary: UndoImportSummary | null = null

    set((state) => {
      const receipt = state.lastImportUndo
      if (!receipt) return {}
      if (
        receipt.expectedLibraryRevision !== state.libraryRevision
        || !isImportUndoReceiptApplicable(state, receipt)
      ) {
        return { lastImportUndo: null }
      }

      const result = undoLibraryImport(state, receipt)
      summary = result.summary
      receipt.addedSampleIds.forEach((sampleId) => audioRuntimeCache.removeSample(sampleId))
      return {
        ...result.state,
        libraryRevision: state.libraryRevision + 1,
        lastImportUndo: null,
        lastUndoSummary: result.summary,
        selectedIds: new Set([...state.selectedIds].filter((id) => result.state.samples.has(id))),
        lastGroupChangeTimestamp: Date.now(),
      }
    })

    return summary
  },

  invalidateLastImportUndo: () => set((state) => ({
    libraryRevision: state.libraryRevision + 1,
    lastImportUndo: null,
  })),

  restoreImportUndoState: (stored) => set((state) => {
    const libraryRevision = Number.isSafeInteger(stored?.libraryRevision)
      ? stored!.libraryRevision
      : 0
    const receipt = stored?.receipt ?? null
    const isValid = receipt !== null
      && receipt.expectedLibraryRevision === libraryRevision
      && isImportUndoReceiptApplicable(state, receipt)

    return {
      libraryRevision,
      lastImportUndo: isValid ? receipt : null,
      lastUndoSummary: null,
    }
  }),

  clearUndoSummary: () => set({ lastUndoSummary: null }),

  restoreFolders: (folderList, folderOrder) => set(() => ({
    folders: new Map(folderList.map((folder) => [folder.id, folder])),
    folderOrder,
  })),

  removeAllImported: () => set(() => {
    audioRuntimeCache.clearAll()
    return {
    samples: new Map(),
    sampleSummaries: new Map(),
    pagedLibrary: false,
    groups: new Map(),
    groupOrder: [],
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
    libraryRevision: get().libraryRevision + 1,
    lastImportUndo: null,
    lastUndoSummary: null,
    }
  }),

  removeSamples: (ids) => {
    const before = get()
    const persistedIds = ids.filter((id) => before.samples.has(id) || before.sampleSummaries.has(id))
    set((state) => {
    const samples = new Map(state.samples)
    const sampleSummaries = new Map(state.sampleSummaries)
    const groups = new Map(state.groups)
    const folders = new Map(state.folders)
    const selectedIds = new Set(state.selectedIds)

    const existingIds = ids.filter((id) => state.samples.has(id) || state.sampleSummaries.has(id))
    if (existingIds.length === 0) return {}

    for (const id of existingIds) {
      samples.delete(id)
      sampleSummaries.delete(id)
      selectedIds.delete(id)
      audioRuntimeCache.removeSample(id)
    }

    for (const [gid, group] of groups) {
      groups.set(gid, {
        ...group,
        sampleIds: group.sampleIds.filter((sid) => !existingIds.includes(sid)),
      })
    }

    for (const [fid, folder] of folders) {
      folders.set(fid, {
        ...folder,
        sampleIds: folder.sampleIds.filter((sid) => !existingIds.includes(sid)),
      })
    }

    return {
      samples,
      sampleSummaries,
      groups,
      folders,
      selectedIds,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
    })
    if (before.pagedLibrary) persistPagedSampleDeletes(persistedIds)
  },

  updateSample: (id, patch) => {
    const persistedKeys = Object.keys(patch).filter((key) => key !== 'waveformData' && key !== 'isDecoded')
    set((state) => {
    const samples = new Map(state.samples)
    const sampleSummaries = new Map(state.sampleSummaries)
    const existing = samples.get(id)
    if (existing) {
      samples.set(id, { ...existing, ...patch })
    }
    const summary = sampleSummaries.get(id)
    if (summary) {
      sampleSummaries.set(id, {
        ...summary,
        fileName: patch.fileName ?? summary.fileName,
        fileExt: patch.fileExt ?? summary.fileExt,
        folderId: patch.folderId === undefined ? summary.folderId : patch.folderId ?? null,
        groupIds: patch.groupIds ?? summary.groupIds,
        importedAt: patch.importedAt ?? summary.importedAt,
      })
    }
    return {
      samples,
      sampleSummaries,
      persistenceVersion: state.persistenceVersion + (persistedKeys.length > 0 ? 1 : 0),
    }
    })
    const state = get()
    const updated = state.samples.get(id)
    if (state.pagedLibrary && persistedKeys.length > 0 && updated) persistPagedSample(updated)
  },

  addGroup: (group) => set((state) => {
    const groups = new Map(state.groups)
    groups.set(group.id, group)
    const groupOrder = reconcileGroupOrder(state.groupOrder, groups)
    return {
      groups,
      groupOrder,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
  }),

  removeGroup: (id) => set((state) => {
    const groups = new Map(state.groups)
    const samples = new Map(state.samples)
    const sampleSummaries = new Map(state.sampleSummaries)
    groups.delete(id)

    for (const [sid, sample] of samples) {
      if (sample.groupIds.includes(id)) {
        samples.set(sid, {
          ...sample,
          groupIds: sample.groupIds.filter((gid) => gid !== id),
        })
      }
    }
    for (const [sid, summary] of sampleSummaries) {
      if (summary.groupIds.includes(id)) {
        sampleSummaries.set(sid, {
          ...summary,
          groupIds: summary.groupIds.filter((groupId) => groupId !== id),
        })
      }
    }

    const groupOrder = reconcileGroupOrder(state.groupOrder.filter((groupId) => groupId !== id), groups)
    return {
      groups,
      groupOrder,
      samples,
      sampleSummaries,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
  }),

  renameGroup: (id, name) => set((state) => {
    const groups = new Map(state.groups)
    const group = groups.get(id)
    if (group) groups.set(id, { ...group, name })
    return {
      groups,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
  }),

  moveGroup: (draggedGroupId, targetGroupId) => set((state) => {
    if (draggedGroupId === targetGroupId) return {}
    const groupOrder = reconcileGroupOrder(state.groupOrder, state.groups)
    const fromIndex = groupOrder.indexOf(draggedGroupId)
    const toIndex = groupOrder.indexOf(targetGroupId)
    if (fromIndex === -1 || toIndex === -1) return {}

    const [draggedId] = groupOrder.splice(fromIndex, 1)
    const nextTargetIndex = groupOrder.indexOf(targetGroupId)
    groupOrder.splice(nextTargetIndex, 0, draggedId)

    return {
      groupOrder,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
  }),

  restoreGroupOrder: (groupOrder, providedGroups) => set((state) => ({
    groupOrder: reconcileGroupOrder(groupOrder, providedGroups ?? state.groups),
  })),

  addToGroup: (sampleIds, groupId) => {
    set((state) => {
    const samples = new Map(state.samples)
    const sampleSummaries = new Map(state.sampleSummaries)
    const groups = new Map(state.groups)

    for (const sid of sampleIds) {
      const sample = samples.get(sid)
      if (sample && !sample.groupIds.includes(groupId)) {
        samples.set(sid, { ...sample, groupIds: [...sample.groupIds, groupId] })
      }
      const summary = sampleSummaries.get(sid)
      if (summary && !summary.groupIds.includes(groupId)) {
        sampleSummaries.set(sid, { ...summary, groupIds: [...summary.groupIds, groupId] })
      }
    }

    const group = groups.get(groupId)
    if (group) {
      groups.set(groupId, {
        ...group,
        sampleIds: [...new Set([...group.sampleIds, ...sampleIds])],
      })
    }

    return {
      samples,
      sampleSummaries,
      groups,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
    })
    const state = get()
    if (state.pagedLibrary) {
      persistPagedSampleGroups(sampleIds.flatMap((sampleId) => {
        const summary = state.sampleSummaries.get(sampleId)
        return summary ? [{ sampleId, groupIds: summary.groupIds }] : []
      }))
    }
  },

  removeFromGroup: (sampleIds, groupId) => {
    set((state) => {
    const samples = new Map(state.samples)
    const sampleSummaries = new Map(state.sampleSummaries)
    const groups = new Map(state.groups)

    for (const sid of sampleIds) {
      const sample = samples.get(sid)
      if (sample) {
        samples.set(sid, {
          ...sample,
          groupIds: sample.groupIds.filter((group) => group !== groupId),
        })
      }
      const summary = sampleSummaries.get(sid)
      if (summary) {
        sampleSummaries.set(sid, {
          ...summary,
          groupIds: summary.groupIds.filter((group) => group !== groupId),
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

    return {
      samples,
      sampleSummaries,
      groups,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
    })
    const state = get()
    if (state.pagedLibrary) {
      persistPagedSampleGroups(sampleIds.flatMap((sampleId) => {
        const summary = state.sampleSummaries.get(sampleId)
        return summary ? [{ sampleId, groupIds: summary.groupIds }] : []
      }))
    }
  },

  setSearchQuery: (searchQuery) => set((state) => {
    const wasEmpty = !state.searchQuery.trim()
    const isEmpty = !searchQuery.trim()

    let preSearchExpandedFolderIds = state.preSearchExpandedFolderIds
    let expandedFolderIds = new Set(state.expandedFolderIds)

    if (!isEmpty) {
      if (wasEmpty) {
        preSearchExpandedFolderIds = new Set(state.expandedFolderIds)
      }

      expandedFolderIds = new Set(preSearchExpandedFolderIds ?? state.expandedFolderIds)
    } else if (!wasEmpty && isEmpty && state.preSearchExpandedFolderIds) {
      expandedFolderIds = new Set(state.preSearchExpandedFolderIds)
      preSearchExpandedFolderIds = null
    }

    return {
      searchQuery,
      searchResultIds: isEmpty ? null : [],
      expandedFolderIds,
      preSearchExpandedFolderIds,
    }
  }),

  setSearchResults: (ids, ancestorFolderIds) => set((state) => {
    if (!state.searchQuery.trim()) return { searchResultIds: null }
    const expandedFolderIds = state.folderSettings.expandOnSearch
      ? new Set([
          ...(state.preSearchExpandedFolderIds ?? state.expandedFolderIds),
          ...ancestorFolderIds,
        ])
      : state.expandedFolderIds
    return { searchResultIds: ids, expandedFolderIds }
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
    return {
      folders,
      folderOrder,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
    }
  }),

  removeFolder: (id) => set((state) => {
    const samples = new Map(state.samples)
    const sampleSummaries = new Map(state.sampleSummaries)
    const groups = new Map(state.groups)
    const folders = new Map(state.folders)
    const selectedIds = new Set(state.selectedIds)
    const expandedFolderIds = new Set(state.expandedFolderIds)
    const hiddenFolderIds = new Set(state.hiddenFolderIds)
    const hiddenSampleIds = new Set(state.hiddenSampleIds)
    const folder = folders.get(id)
    if (!folder) return {}

    const folderIdsToRemove = collectDescendantFolderIds(id, folders)
    const sampleIdsToRemove = new Set<string>()
    folderIdsToRemove.forEach((folderId) => {
      collectFolderSampleIds(folderId, folders).forEach((sampleId) => sampleIdsToRemove.add(sampleId))
    })

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

    for (const sampleId of sampleIdsToRemove) {
      samples.delete(sampleId)
      sampleSummaries.delete(sampleId)
      selectedIds.delete(sampleId)
      hiddenSampleIds.delete(sampleId)
      audioRuntimeCache.removeSample(sampleId)
    }

    for (const [groupId, group] of groups) {
      groups.set(groupId, {
        ...group,
        sampleIds: group.sampleIds.filter((sampleId) => !sampleIdsToRemove.has(sampleId)),
      })
    }

    folderOrder = [...folderOrder]
    return {
      samples,
      sampleSummaries,
      groups,
      folders,
      folderOrder,
      selectedIds,
      expandedFolderIds,
      hiddenFolderIds,
      hiddenSampleIds,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
      lastGroupChangeTimestamp: Date.now(),
    }
  }),

  renameFolder: (id, name) => set((state) => {
    const folders = new Map(state.folders)
    const folder = folders.get(id)
    if (!folder || folder.name === name) return {}
    folders.set(id, { ...folder, name })
    return {
      folders,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
    }
  }),

  toggleFolderExpanded: (id) => set((state) => {
    const expandedFolderIds = new Set(state.expandedFolderIds)
    if (expandedFolderIds.has(id)) {
      expandedFolderIds.delete(id)
    } else {
      expandedFolderIds.add(id)
    }
    return {
      expandedFolderIds,
      persistenceVersion: state.persistenceVersion + 1,
    }
  }),

  setFolderExpanded: (id, expanded) => set((state) => {
    const expandedFolderIds = new Set(state.expandedFolderIds)
    if (expanded) expandedFolderIds.add(id)
    else expandedFolderIds.delete(id)
    return {
      expandedFolderIds,
      persistenceVersion: state.persistenceVersion + 1,
    }
  }),

  moveFolder: (fromIndex, toIndex) => set((state) => {
    if (fromIndex === toIndex || !state.folderOrder[fromIndex] || toIndex < 0 || toIndex >= state.folderOrder.length) {
      return {}
    }
    const folderOrder = [...state.folderOrder]
    const [moved] = folderOrder.splice(fromIndex, 1)
    folderOrder.splice(toIndex, 0, moved)
    return {
      folderOrder,
      libraryRevision: state.libraryRevision + 1,
      lastImportUndo: null,
    }
  }),

  setExpandOnSearch: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, expandOnSearch: value },
    persistenceVersion: state.persistenceVersion + 1,
  })),

  setFolderClassificationEnabled: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, folderClassificationEnabled: value },
    persistenceVersion: state.persistenceVersion + 1,
  })),

  setMemoryOptimizationMode: (value) => {
    audioRuntimeCache.setMemoryOptimizationMode(value)
    set((state) => ({
      folderSettings: { ...state.folderSettings, memoryOptimizationMode: value },
      persistenceVersion: state.persistenceVersion + 1,
    }))
  },

  setEnableChinesePinyinFuzzySearch: (value) => set((state) => ({
    folderSettings: { ...state.folderSettings, enableChinesePinyinFuzzySearch: value },
    persistenceVersion: state.persistenceVersion + 1,
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
  }),

  closeContextMenu: () => set({ contextMenuTarget: null }),
  setShowSelectionBar: (show) => set({ showSelectionBar: show }),

  getFilteredSamples: () => {
    const state = get()
    return getFilteredSamplesCached(state)
  },

  getOrderedIds: () => getOrderedIdsCached(get().getFilteredSamples()),

  getFolderForSample: (sampleId) => {
    const { samples, sampleSummaries, folders } = get()
    const sample = samples.get(sampleId)
    const folderId = sample?.folderId ?? sampleSummaries.get(sampleId)?.folderId
    if (!folderId) return null
    return folders.get(folderId) ?? null
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
