/// <reference types="vite/client" />

import React, { Suspense, useEffect, useCallback, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuidv4 } from 'uuid'
import { FileText, Loader2, Music2, X } from 'lucide-react'

import { TitleBar } from '@/components/TitleBar'
import { SearchBar } from '@/components/SearchBar'
import { GroupBar } from '@/components/GroupBar'
import { SampleItem } from '@/components/SampleList/SampleItem'
import { FolderItem } from '@/components/FolderItem'
import { StatusBar } from '@/components/StatusBar/StatusBar'
import { ContextMenu } from '@/components/ContextMenu'
import { ImportResultBanner } from '@/components/ImportResultBanner'

import { useSampleStore } from '@/store/sampleStore'
import { usePlayerStore } from '@/store/playerStore'
import { useAudioEngine } from '@/hooks/useAudioEngine'
import { useSearchWorker } from '@/hooks/useSearch'
import { useTauriLibraryPersistence } from '@/hooks/useTauriLibraryPersistence'
import type {
  ImportCandidate,
  ImportFailure,
  ImportSummary,
  Sample,
  SampleFolder,
  SampleSummary,
  ScannedFolderNode,
  StoredFolderState,
  StoredImportUndoState,
  UpdateState,
} from '@/types'
import { reconcileLibraryState } from '@/services/libraryImport'
import { buildLyricsSourceSampleIndex, planLyricsAssembly } from '@/services/lyricsSampleAssembler'
import { decodeLyricsText, getDefaultLyricsGroupName, tokenizeLyricsText } from '@/services/lyricsPinyinService'
import { getDesktopBridge } from '@/services/desktopBridge'
import type { DesktopBridge, ImportProgress, LibraryBootstrap, LibrarySampleRecord } from '@/services/desktopBridge'
import { LibraryPageCache } from '@/services/libraryPageCache'
import type { LyricsMissingItem, LyricToken } from '@/types/lyrics'

function getFileNameParts(filePath: string) {
  const pathParts = filePath.replace(/\\/g, '/').split('/')
  const fullFileName = pathParts[pathParts.length - 1]
  const dotIndex = fullFileName.lastIndexOf('.')

  return {
    fileName: dotIndex > 0 ? fullFileName.substring(0, dotIndex) : fullFileName,
    fileExt: dotIndex > 0 ? fullFileName.substring(dotIndex) : '',
  }
}

function buildStructuredFolders(root: ScannedFolderNode) {
  const folders: SampleFolder[] = []
  const rootFolderIds: string[] = []

  const walk = (
    node: ScannedFolderNode,
    parentId: string | null,
    rootId: string,
    depth: number,
    importedAt: number,
  ): string => {
    const normalizedPath = node.path.replace(/\\/g, '/')
    const folderId = `folder_${normalizedPath}`
    const childFolderIds = node.children.map((child) => `folder_${child.path.replace(/\\/g, '/')}`)

    folders.push({
      id: folderId,
      name: node.name,
      path: normalizedPath,
      sampleIds: [],
      childFolderIds,
      parentId,
      rootId,
      depth,
      importedAt,
      isExpanded: false,
      order: 0,
      isRenaming: false,
    })

    if (parentId === null) {
      rootFolderIds.push(folderId)
    }

    node.children.forEach((child) => {
      walk(child, folderId, rootId, depth + 1, importedAt)
    })

    return folderId
  }

  const importedAt = Date.now()
  const rootId = `folder_${root.path.replace(/\\/g, '/')}`
  walk(root, null, rootId, 0, importedAt)

  return { folders, rootFolderIds, importedAt }
}

function toSample(item: LibrarySampleRecord): Sample {
  return {
    id: item.id,
    fileName: item.fileName,
    fileExt: item.extension,
    filePath: item.filePath,
    folderId: item.folderId,
    originalId: item.originalId,
    isCopy: item.isCopy,
    copyIndex: item.copyIndex,
    duration: (item.durationMs ?? 0) / 1000,
    sampleRate: item.sampleRate ?? 0,
    channels: item.channels ?? 0,
    fileSize: item.fileSize,
    groupIds: item.groupIds,
    importedAt: item.importedAt,
    isDecoded: false,
    isFileValid: item.isValid,
  }
}

const TAURI_LIBRARY_PAGE_SIZE = 256
const tauriLibraryPageCache = new LibraryPageCache<Sample>({
  pageSize: TAURI_LIBRARY_PAGE_SIZE,
  maxPages: 8,
})
let tauriHydrationSequence = 0
const pendingTauriPages = new Map<number, Promise<void>>()

function syncTauriPageCacheToStore(): void {
  useSampleStore.getState().replaceCachedSamples(tauriLibraryPageCache.items())
}

function applyTauriLibrarySnapshot(
  bootstrap: LibraryBootstrap,
  summaries: SampleSummary[],
  cachedSamples: Sample[],
): void {
  const restoredFolders = new Map<string, SampleFolder>(bootstrap.folders.map((folder) => [folder.id, {
    id: folder.id,
    name: folder.name,
    path: folder.path,
    sampleIds: [],
    childFolderIds: [],
    parentId: folder.parentId,
    rootId: folder.rootId,
    depth: folder.depth,
    importedAt: folder.importedAt,
    isExpanded: folder.isExpanded,
    order: folder.order,
    isRenaming: false,
  }]))
  restoredFolders.forEach((folder) => {
    if (folder.parentId) restoredFolders.get(folder.parentId)?.childFolderIds.push(folder.id)
  })
  summaries.forEach((sample) => {
    if (sample.folderId) restoredFolders.get(sample.folderId)?.sampleIds.push(sample.id)
  })

  const restoredGroups = new Map(bootstrap.groups.map((group) => [group.id, {
    id: group.id,
    name: group.name,
    color: group.color,
    sampleIds: [] as string[],
  }]))
  summaries.forEach((sample) => {
    sample.groupIds.forEach((groupId) => restoredGroups.get(groupId)?.sampleIds.push(sample.id))
  })

  const storedFolderSettings = bootstrap.settings.folderSettings as Partial<ReturnType<typeof useSampleStore.getState>['folderSettings']> | undefined
  useSampleStore.setState((state) => ({
    samples: new Map(cachedSamples.map((sample) => [sample.id, sample])),
    sampleSummaries: new Map(summaries.map((summary) => [summary.id, summary])),
    pagedLibrary: true,
    folders: restoredFolders,
    folderOrder: bootstrap.folderOrder,
    groups: restoredGroups,
    groupOrder: bootstrap.groupOrder,
    expandedFolderIds: new Set(
      bootstrap.folders.filter((folder) => folder.isExpanded).map((folder) => folder.id),
    ),
    folderSettings: storedFolderSettings
      ? { ...state.folderSettings, ...storedFolderSettings }
      : state.folderSettings,
    lastGroupChangeTimestamp: Date.now(),
    libraryRevision: state.libraryRevision + 1,
  }))
}

async function hydrateTauriLibrary(desktop: DesktopBridge, showFirstPageEarly = false): Promise<void> {
  const hydrationSequence = ++tauriHydrationSequence
  const generation = tauriLibraryPageCache.reset()
  pendingTauriPages.clear()
  const [bootstrap, firstPage] = await Promise.all([
    desktop.library.getBootstrap(),
    desktop.library.queryPage({ offset: 0, limit: TAURI_LIBRARY_PAGE_SIZE }),
  ])
  if (hydrationSequence !== tauriHydrationSequence) return
  const firstSamples = firstPage.items.map(toSample)
  tauriLibraryPageCache.storePage(0, firstSamples, generation)

  const summaries: SampleSummary[] = []
  let globalOffset = 0
  for await (const batch of desktop.library.getSearchIndexBatches(1000)) {
    if (hydrationSequence !== tauriHydrationSequence) return
    for (const document of batch.documents) {
      summaries.push({
        kind: 'sample-summary',
        id: document.id,
        fileName: document.fileName,
        fileExt: document.extension,
        folderId: document.folderId,
        groupIds: document.groupIds,
        importedAt: document.importedAt,
        pageIndex: Math.floor(globalOffset / TAURI_LIBRARY_PAGE_SIZE),
      })
      globalOffset += 1
    }
  }
  if (hydrationSequence !== tauriHydrationSequence) return
  applyTauriLibrarySnapshot(bootstrap, summaries, tauriLibraryPageCache.items())
  if (showFirstPageEarly) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  }
}

async function ensureTauriLibraryPage(desktop: DesktopBridge, pageIndex: number): Promise<void> {
  if (desktop.runtime !== 'tauri' || tauriLibraryPageCache.hasPage(pageIndex)) return
  const existing = pendingTauriPages.get(pageIndex)
  if (existing) return existing

  const generation = tauriLibraryPageCache.currentGeneration()
  const request = desktop.library.queryPage({
    offset: pageIndex * TAURI_LIBRARY_PAGE_SIZE,
    limit: TAURI_LIBRARY_PAGE_SIZE,
  }).then((page) => {
    if (tauriLibraryPageCache.storePage(pageIndex, page.items.map(toSample), generation)) {
      syncTauriPageCacheToStore()
    }
  }).finally(() => {
    pendingTauriPages.delete(pageIndex)
  })
  pendingTauriPages.set(pageIndex, request)
  return request
}

const SelectionBar = React.lazy(() =>
  import('@/components/SelectionBar').then((module) => ({ default: module.SelectionBar }))
)

export default function App() {
  const desktop = getDesktopBridge()
  useSearchWorker()
  const listRef = React.useRef<HTMLDivElement>(null)
  const selectAllRef = React.useRef<HTMLInputElement>(null)
  const groupScrollPositionsRef = React.useRef<Map<string, number>>(new Map())
  const previousGroupScrollKeyRef = React.useRef('__all__')
  const previousSearchQueryRef = React.useRef('')
  const importTargetGroupIdRef = React.useRef<string | null>(null)
  
  const samples = useSampleStore((state) => state.samples)
  const sampleSummaries = useSampleStore((state) => state.sampleSummaries)
  const sampleCount = useSampleStore((state) => state.pagedLibrary ? state.sampleSummaries.size : state.samples.size)
  const selectedIds = useSampleStore((state) => state.selectedIds)
  const addSamples = useSampleStore((state) => state.addSamples)
  const addGroup = useSampleStore((state) => state.addGroup)
  const commitImport = useSampleStore((state) => state.commitImport)
  const removeAllImported = useSampleStore((state) => state.removeAllImported)
  const setDecodeProgress = useSampleStore((state) => state.setDecodeProgress)
  const toggleSelected = useSampleStore((state) => state.toggleSelected)
  const clearSelection = useSampleStore((state) => state.clearSelection)
  const selectAll = useSampleStore((state) => state.selectAll)
  const setAnchorId = useSampleStore((state) => state.setAnchorId)
  const setSelected = useSampleStore((state) => state.setSelected)
  const setActiveGroupId = useSampleStore((state) => state.setActiveGroupId)
  const toggleFolderExpanded = useSampleStore((state) => state.toggleFolderExpanded)
  const renameFolder = useSampleStore((state) => state.renameFolder)
  const removeFolder = useSampleStore((state) => state.removeFolder)
  const moveFolder = useSampleStore((state) => state.moveFolder)
  const getOrderedIds = useSampleStore((state) => state.getOrderedIds)
  const folders = useSampleStore((state) => state.folders)
  const folderOrder = useSampleStore((state) => state.folderOrder)
  const expandedFolderIds = useSampleStore((state) => state.expandedFolderIds)

  const currentSampleId = usePlayerStore((state) => state.currentSampleId)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const { play, stopPlayback, togglePause, seekTo, getWaveform, beginShutdown } = useAudioEngine()
  const folderSettings = useSampleStore(state => state.folderSettings)
  const groups = useSampleStore(state => state.groups)
  const groupOrder = useSampleStore(state => state.groupOrder)
  const isImporting = useSampleStore(state => state.isImporting)
  const searchQuery = useSampleStore(state => state.searchQuery)
  const activeGroupId = useSampleStore(state => state.activeGroupId)
  const contextMenuTarget = useSampleStore(state => state.contextMenuTarget)
  const lastUndoSummary = useSampleStore(state => state.lastUndoSummary)
  const libraryRevision = useSampleStore(state => state.libraryRevision)
  const lastImportUndo = useSampleStore(state => state.lastImportUndo)

  const [currentWaveform, setCurrentWaveform] = useState<Float32Array | null>(null)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: 'idle',
    currentVersion: '',
    availableVersion: null,
    progressPercent: null,
    message: null,
    action: 'none',
  })
  const [hasHydratedStore, setHasHydratedStore] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [libraryWritable, setLibraryWritable] = useState(true)
  const isLibraryReadOnly = desktop.runtime === 'tauri' && !libraryWritable
  useTauriLibraryPersistence(hasHydratedStore && desktop.runtime === 'tauri' && libraryWritable)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [currentImportSession, setCurrentImportSession] = useState<string | null>(null)
  const [showLyricsAssembler, setShowLyricsAssembler] = useState(false)
  const [lyricsFilePath, setLyricsFilePath] = useState('')
  const [lyricsTokens, setLyricsTokens] = useState<LyricToken[]>([])
  const [lyricsSourceGroupId, setLyricsSourceGroupId] = useState('')
  const [lyricsTargetGroupName, setLyricsTargetGroupName] = useState('')
  const [isAssemblingLyrics, setIsAssemblingLyrics] = useState(false)
  const [lyricsResult, setLyricsResult] = useState<{
    successCount: number
    missing: LyricsMissingItem[]
    failedCopies: number
  } | null>(null)
  const closeImportSummary = useCallback(() => setImportSummary(null), [])
  const isUpdateBlocking = updateState.phase === 'downloading' || updateState.phase === 'installing'

  useEffect(() => {
    const handlePersistenceError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      setStartupError((current) => [
        current,
        `SQLite 增量保存失败；本次未确认的数据仍保留在界面中。\n错误：${message}`,
      ].filter(Boolean).join('\n\n'))
    }
    window.addEventListener('otto:persistence-error', handlePersistenceError)
    return () => window.removeEventListener('otto:persistence-error', handlePersistenceError)
  }, [])

  const handleCheckForUpdates = useCallback(() => {
    void desktop.updater.check({ manual: true }).then(setUpdateState).catch(() => undefined)
  }, [])
  const handleStartUpdate = useCallback(() => {
    void desktop.updater.start().catch(() => undefined)
  }, [])
  const handleListContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    useSampleStore.getState().openContextMenu('background', '', event.clientX, event.clientY)
  }, [])

  const orderedIds = getOrderedIds()
  const selectableCount = orderedIds.length
  const selectedVisibleCount = orderedIds.filter(id => selectedIds.has(id)).length
  const isAllSelected = selectableCount > 0 && selectedVisibleCount === selectableCount
  const isPartiallySelected = selectedVisibleCount > 0 && selectedVisibleCount < selectableCount
  const primarySelectedId = selectedIds.values().next().value as string | undefined
  const primarySelectedSample = primarySelectedId ? samples.get(primarySelectedId) ?? null : null
  const canControlPrimarySample = Boolean(primarySelectedSample && primarySelectedSample.isFileValid)
  const isPrimarySamplePlaying = Boolean(
    primarySelectedSample &&
    currentSampleId === primarySelectedSample.id &&
    isPlaying
  )

  // 虚拟列表
  const flattenedItems = useSampleStore(state => {
    // 依赖分组更改时间戳以确保分组更改时刷新
    state.lastGroupChangeTimestamp;
    return state.getFlattenedItems();
  })

  const listResetKey = useMemo(
    () => `${searchQuery}\u0000${activeGroupId ?? 'all'}\u0000${flattenedItems.length}`,
    [activeGroupId, flattenedItems.length, searchQuery],
  )

  const virtualizer = useVirtualizer({
    count: flattenedItems.length,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => {
      const item = flattenedItems[index]
      if (!item) return `missing-${index}`
      return 'path' in item ? `folder-${item.id}` : `sample-${item.id}`
    },
    estimateSize: () => 44,
    overscan: 10,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const memoryOptimizationMode = useSampleStore((state) => state.folderSettings.memoryOptimizationMode)
  const anchorId = useSampleStore((state) => state.anchorId)
  const visiblePageKey = virtualItems
    .map((row) => {
      const item = flattenedItems[row.index]
      if (!item || 'path' in item) return -1
      return sampleSummaries.get(item.id)?.pageIndex ?? -1
    })
    .filter((pageIndex) => pageIndex >= 0)
    .join(',')

  useEffect(() => {
    if (desktop.runtime !== 'tauri') return
    tauriLibraryPageCache.setMaxPages(memoryOptimizationMode ? 3 : 8)
    tauriLibraryPageCache.setPinnedIds(new Set([
      ...selectedIds,
      ...(currentSampleId ? [currentSampleId] : []),
      ...(anchorId ? [anchorId] : []),
    ]))

    const visiblePages = visiblePageKey
      .split(',')
      .map(Number)
      .filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0)
    tauriLibraryPageCache.setRequiredPageIndexes(new Set(visiblePages))
    const pagesToLoad = new Set<number>()
    for (const pageIndex of visiblePages) {
      pagesToLoad.add(pageIndex)
      if (!searchQuery.trim()) {
        if (pageIndex > 0) pagesToLoad.add(pageIndex - 1)
        pagesToLoad.add(pageIndex + 1)
      }
    }
    void Promise.all([...pagesToLoad].map((pageIndex) => ensureTauriLibraryPage(desktop, pageIndex)))
    syncTauriPageCacheToStore()
  }, [anchorId, currentSampleId, desktop, memoryOptimizationMode, searchQuery, selectedIds, visiblePageKey])

  useEffect(() => {
    const previousGroupKey = previousGroupScrollKeyRef.current
    const currentGroupKey = activeGroupId ?? '__all__'
    const previousSearchQuery = previousSearchQueryRef.current.trim()
    const currentSearchQuery = searchQuery.trim()
    const listElement = listRef.current

    if (listElement && previousSearchQuery === '') {
      groupScrollPositionsRef.current.set(previousGroupKey, listElement.scrollTop)
    }

    virtualizer.measure()
    const nextScrollTop = currentSearchQuery
      ? 0
      : groupScrollPositionsRef.current.get(currentGroupKey) ?? 0

    const frameId = window.requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: nextScrollTop })
    })

    previousGroupScrollKeyRef.current = currentGroupKey
    previousSearchQueryRef.current = searchQuery

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [activeGroupId, listResetKey, searchQuery])

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = isPartiallySelected
    }
  }, [isPartiallySelected])

  useEffect(() => {
    const hydrateStore = async () => {
      if (desktop.runtime === 'tauri') {
        const status = await desktop.startup.getStatus()
        setStartupError(status.error)
        setLibraryWritable(status.writable)
        await hydrateTauriLibrary(desktop, true)
        setHasHydratedStore(true)
        return
      }
      const legacyStorage = desktop.legacyStorage
      if (!legacyStorage) throw new Error('Electron legacy storage is unavailable')
      const storedSamples = await legacyStorage.get('samples') as Record<string, any> | null
      const storedFolderState = await legacyStorage.get('folderState') as StoredFolderState | null
      const storedSettings = await legacyStorage.get('folderSettings') as any
      const storedGroups = await legacyStorage.get('groups') as Record<string, any> | null
      const storedGroupOrder = await legacyStorage.get('groupOrder') as string[] | null
      const storedImportUndoState = await legacyStorage.get('importUndoState') as StoredImportUndoState | null

      if (storedSettings) {
        const {
          setExpandOnSearch,
          setFolderClassificationEnabled,
          setMemoryOptimizationMode,
          setEnableChinesePinyinFuzzySearch,
        } = useSampleStore.getState()
        if (storedSettings.expandOnSearch !== undefined) {
          setExpandOnSearch(storedSettings.expandOnSearch)
        }
        if (storedSettings.folderClassificationEnabled !== undefined) {
          setFolderClassificationEnabled(storedSettings.folderClassificationEnabled)
        }
        if (storedSettings.memoryOptimizationMode !== undefined) {
          setMemoryOptimizationMode(storedSettings.memoryOptimizationMode)
        }
        if (storedSettings.enableChinesePinyinFuzzySearch !== undefined) {
          setEnableChinesePinyinFuzzySearch(storedSettings.enableChinesePinyinFuzzySearch)
        }
      }

      const sampleList: Sample[] = Object.values(storedSamples ?? {}).map(s => ({
        ...s,
        folderId: s.folderId ?? null,
        originalId: s.originalId ?? s.id,
        isCopy: s.isCopy ?? false,
        copyIndex: s.copyIndex ?? 0,
        groupIds: Array.isArray(s.groupIds) ? s.groupIds : [],
        isDecoded: false,
        isFileValid: true,  // 先假设有效，后面验证
      }))

      // 验证文件是否仍然存在
      const validationResult = sampleList.length > 0
        ? await desktop.library.validateFiles(sampleList.map(s => s.filePath))
        : []
      
      const validationMap = new Map<string, boolean>(validationResult.map((r: any) => [r.path, r.valid]))
      const validatedSamples: Sample[] = sampleList.map(s => ({
        ...s,
        isFileValid: validationMap.get(s.filePath) ?? false
      }))

      const restoredGroups = new Map(
        Object.values(storedGroups ?? {}).map((group: any) => [group.id, {
          ...group,
          sampleIds: Array.isArray(group.sampleIds) ? group.sampleIds : [],
        }]),
      )
      const restoredFolders = new Map(
        Object.values(storedFolderState?.folders ?? {}).map((folder: any) => [folder.id, {
          ...folder,
          sampleIds: Array.isArray(folder.sampleIds) ? folder.sampleIds : [],
          childFolderIds: Array.isArray(folder.childFolderIds) ? folder.childFolderIds : [],
          parentId: folder.parentId ?? null,
          rootId: folder.rootId ?? folder.id,
          depth: folder.depth ?? 0,
          importedAt: folder.importedAt ?? 0,
        }]),
      )
      const reconciled = reconcileLibraryState({
        samples: new Map(validatedSamples.map((sample) => [sample.id, sample])),
        groups: restoredGroups,
        folders: restoredFolders,
        folderOrder: storedFolderState?.folderOrder ?? [],
      })

      useSampleStore.setState({
        samples: reconciled.samples,
        groups: reconciled.groups,
        folders: reconciled.folders,
        folderOrder: reconciled.folderOrder,
        lastGroupChangeTimestamp: Date.now(),
      })
      useSampleStore.getState().restoreGroupOrder(storedGroupOrder, reconciled.groups)
      useSampleStore.getState().restoreImportUndoState(storedImportUndoState)

      setHasHydratedStore(true)
    }

    hydrateStore().catch(() => {
      setHasHydratedStore(true)
      setDecodeProgress(null)
      useSampleStore.getState().setIsImporting(false)
    })
  }, [setDecodeProgress])

  useEffect(() => desktop.library.onImportProgress((progress) => {
    setImportProgress(progress)
    setDecodeProgress({ current: progress.processed, total: Math.max(progress.discovered, progress.processed) })
    if (progress.state === 'scanning') return

    setCurrentImportSession(null)
    useSampleStore.getState().setIsImporting(false)
    setDecodeProgress(null)
    const targetGroupId = importTargetGroupIdRef.current
    importTargetGroupIdRef.current = null
    void hydrateTauriLibrary(desktop).then(() => {
      if (progress.state === 'committed') {
        setImportSummary({
          scanned: progress.discovered,
          added: progress.added,
          linkedToGroup: progress.linkedToGroup,
          skipped: progress.duplicates,
          failed: progress.failed,
          targetGroupId,
          failures: progress.message ? [{ path: progress.currentPath ?? 'library', stage: 'commit', reason: progress.message }] : [],
        })
        return
      }
      const reason = progress.state === 'cancelled'
        ? '用户已取消导入，未提交的记录已清理'
        : progress.message ?? '后台导入失败，未提交的记录已清理'
      setImportSummary({
        scanned: progress.discovered,
        added: 0,
        linkedToGroup: 0,
        skipped: progress.duplicates,
        failed: Math.max(1, progress.failed),
        targetGroupId,
        failures: [{ path: progress.currentPath ?? 'library', stage: 'commit', reason }],
      })
    }).catch((error) => {
      setImportSummary({
        scanned: progress.discovered,
        added: 0,
        linkedToGroup: 0,
        skipped: progress.duplicates,
        failed: Math.max(1, progress.failed),
        targetGroupId,
        failures: [{ path: 'library', stage: 'commit', reason: `刷新素材库失败：${String(error)}` }],
      })
    })
  }), [setDecodeProgress])

  useEffect(() => {
    if (desktop.runtime !== 'tauri') return
    const refreshLibrary = () => { void hydrateTauriLibrary(desktop) }
    window.addEventListener('otto:library-changed', refreshLibrary)
    return () => window.removeEventListener('otto:library-changed', refreshLibrary)
  }, [])

  useEffect(() => {
    let disposed = false
    desktop.updater.getState()
      .then((state) => {
        if (!disposed) setUpdateState(state)
      })
      .catch(() => undefined)
    const unsubscribe = desktop.updater.onState((state) => {
      if (!disposed) setUpdateState(state)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const handleShutdown = () => {
      beginShutdown()
      setDecodeProgress(null)
    }

    window.addEventListener('beforeunload', handleShutdown)

    return () => {
      window.removeEventListener('beforeunload', handleShutdown)
    }
  }, [beginShutdown, setDecodeProgress])

  useEffect(() => {
    if (!hasHydratedStore || desktop.runtime === 'tauri') {
      return
    }

    const samplesToSave: Record<string, any> = {}
    for (const [id, sample] of samples) {
      const { waveformData, isDecoded, isFileValid, ...persistedSample } = sample
      samplesToSave[id] = {
        ...persistedSample,
        // 不保存运行时数据
      }
    }

    desktop.legacyStorage?.set('samples', samplesToSave).catch((error) => {
      console.error('保存 samples 失败', error)
    })
  }, [hasHydratedStore, samples])

  useEffect(() => {
    if (!hasHydratedStore || desktop.runtime === 'tauri') {
      return
    }

    const folderState: StoredFolderState = {
      folders: {},
      folderOrder,
    }

    for (const [id, folder] of folders) {
      folderState.folders[id] = folder
    }

    desktop.legacyStorage?.set('folderState', folderState).catch((error) => {
      console.error('保存 folderState 失败', error)
    })
  }, [folders, folderOrder, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore || desktop.runtime === 'tauri') {
      return
    }

    const groupsToSave: Record<string, any> = {}
    for (const [id, group] of groups) {
      groupsToSave[id] = group
    }
    desktop.legacyStorage?.set('groups', groupsToSave).catch((error) => {
      console.error('保存 groups 失败', error)
    })
  }, [groups, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore || desktop.runtime === 'tauri') {
      return
    }

    desktop.legacyStorage?.set('groupOrder', groupOrder).catch((error) => {
      console.error('保存 groupOrder 失败', error)
    })
  }, [groupOrder, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore || desktop.runtime === 'tauri') {
      return
    }

    desktop.legacyStorage?.set('folderSettings', folderSettings).catch((error) => {
      console.error('保存 folderSettings 失败', error)
    })
  }, [folderSettings, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore || desktop.runtime === 'tauri') return
    const { libraryRevision, lastImportUndo } = useSampleStore.getState()
    const importUndoState: StoredImportUndoState = {
      libraryRevision,
      receipt: lastImportUndo,
    }
    desktop.legacyStorage?.set('importUndoState', importUndoState).catch((error) => {
      console.error('保存 importUndoState 失败', error)
    })
  }, [hasHydratedStore, libraryRevision, lastImportUndo])

  useEffect(() => {
    if (!currentSampleId || samples.has(currentSampleId)) {
      return
    }

    stopPlayback({ resetTime: true, clearSample: true })
    setCurrentWaveform(null)
  }, [currentSampleId, samples, stopPlayback])

  useEffect(() => {
    const handleWaveformReady = (event: Event) => {
      const { sampleId, waveform } = (event as CustomEvent<{
        sampleId: string
        waveform: Float32Array
      }>).detail
      if (usePlayerStore.getState().currentSampleId === sampleId) {
        setCurrentWaveform(waveform)
      }
    }
    window.addEventListener('otto:waveform-ready', handleWaveformReady)
    return () => window.removeEventListener('otto:waveform-ready', handleWaveformReady)
  }, [])

  // ------------------------------
  // 导入文件
  // ------------------------------
  const runImport = useCallback(async ({
    filePaths,
    importedFolders = [],
    rootFolderIds = [],
    scannedFileCount,
    initialFailures = [],
    lockAlreadyHeld = false,
  }: {
    filePaths: string[]
    importedFolders?: SampleFolder[]
    rootFolderIds?: string[]
    scannedFileCount: number
    initialFailures?: ImportFailure[]
    lockAlreadyHeld?: boolean
  }) => {
    if (!lockAlreadyHeld) {
      if (isUpdateBlocking || useSampleStore.getState().isImporting) return
      useSampleStore.getState().setIsImporting(true)
    }

    const candidates: ImportCandidate[] = []
    const failures = initialFailures.map((failure) => ({ ...failure }))
    const targetGroupId = useSampleStore.getState().activeGroupId
    const folderMap = new Map(importedFolders.map((folder) => [folder.path, folder]))

    try {
      const fileInfoByPath = new Map(
        (await desktop.library.getFilesInfo(filePaths)).map((fileInfo) => [fileInfo.path, fileInfo]),
      )
      for (const [index, filePath] of filePaths.entries()) {
        try {
          const fileInfo = fileInfoByPath.get(filePath)
          if (!fileInfo?.exists) {
            failures.push({
              path: filePath,
              stage: 'metadata',
              reason: fileInfo?.reason || '文件不存在或无法读取',
            })
            continue
          }
          const { fileName, fileExt } = getFileNameParts(filePath)
          const sampleId = uuidv4()
          const folderPath = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
          const candidate: ImportCandidate = {
            id: sampleId,
            fileName,
            fileExt,
            filePath,
            folderId: folderMap.get(folderPath)?.id ?? null,
            originalId: sampleId,
            isCopy: false,
            copyIndex: 0,
            duration: 0,
            sampleRate: 0,
            channels: 0,
            fileSize: fileInfo.fileSize,
            importedAt: Date.now() + index,
            isDecoded: false,
            isFileValid: true,
          }
          candidates.push(candidate)
        } catch (error) {
          failures.push({
            path: filePath,
            stage: 'metadata',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const summary = commitImport({
        candidates,
        folders: importedFolders,
        rootFolderIds,
        targetGroupId,
        scannedFileCount,
        failures,
      })
      setImportSummary(summary)
      setDecodeProgress(null)
    } catch (error) {
      const commitFailure: ImportFailure = {
        path: targetGroupId ?? 'library',
        stage: 'commit',
        reason: error instanceof Error ? error.message : String(error),
      }
      setImportSummary({
        scanned: scannedFileCount,
        added: 0,
        linkedToGroup: 0,
        skipped: 0,
        failed: failures.length + 1,
        targetGroupId,
        failures: [...failures, commitFailure],
      })
    } finally {
      if (!lockAlreadyHeld) {
        useSampleStore.getState().setIsImporting(false)
      }
    }
  }, [commitImport, isUpdateBlocking, setDecodeProgress])

  const handleImportFiles = useCallback(async () => {
    if (isUpdateBlocking || isLibraryReadOnly || useSampleStore.getState().isImporting) return
    useSampleStore.getState().setIsImporting(true)
    let startedTauriImport = false

    try {
      const paths = await desktop.dialogs.openFiles()
      if (paths.length === 0) return
      if (desktop.runtime === 'tauri') {
        const targetGroupId = useSampleStore.getState().activeGroupId
        importTargetGroupIdRef.current = targetGroupId
        const sessionId = await desktop.library.startImport({
          filePaths: paths,
          targetGroupId,
        })
        startedTauriImport = true
        setCurrentImportSession(sessionId)
        return
      }
      await runImport({
        filePaths: paths,
        scannedFileCount: paths.length,
        lockAlreadyHeld: true,
      })
    } catch (error) {
      importTargetGroupIdRef.current = null
      const failure: ImportFailure = {
        path: '文件选择',
        stage: 'scan',
        reason: error instanceof Error ? error.message : String(error),
      }
      setImportSummary({
        scanned: 0,
        added: 0,
        linkedToGroup: 0,
        skipped: 0,
        failed: 1,
        targetGroupId: useSampleStore.getState().activeGroupId,
        failures: [failure],
      })
    } finally {
      if (desktop.runtime !== 'tauri' || !startedTauriImport) {
        useSampleStore.getState().setIsImporting(false)
      }
    }
  }, [isLibraryReadOnly, isUpdateBlocking, runImport])

  const handleImportFolder = useCallback(async () => {
    if (isUpdateBlocking || isLibraryReadOnly || useSampleStore.getState().isImporting) return
    useSampleStore.getState().setIsImporting(true)
    let selectedFolder: string | null = null
    let startedTauriImport = false

    try {
      selectedFolder = await desktop.dialogs.openFolder()
      if (!selectedFolder) return
      if (desktop.runtime === 'tauri') {
        const targetGroupId = useSampleStore.getState().activeGroupId
        importTargetGroupIdRef.current = targetGroupId
        const sessionId = await desktop.library.startImport({
          rootPath: selectedFolder,
          targetGroupId,
        })
        startedTauriImport = true
        setCurrentImportSession(sessionId)
        return
      }
      const scanResult = await desktop.library.scanFolder(selectedFolder)

      const collectFiles = (node: ScannedFolderNode): string[] => [
        ...node.files,
        ...node.children.flatMap(collectFiles),
      ]

      if (!scanResult.root) {
        await runImport({
          filePaths: [],
          scannedFileCount: scanResult.scannedFileCount,
          initialFailures: scanResult.failures,
          lockAlreadyHeld: true,
        })
        return
      }

      const { folders: builtFolders, rootFolderIds } = buildStructuredFolders(scanResult.root)
      await runImport({
        filePaths: collectFiles(scanResult.root),
        importedFolders: builtFolders,
        rootFolderIds,
        scannedFileCount: scanResult.scannedFileCount,
        initialFailures: scanResult.failures,
        lockAlreadyHeld: true,
      })
    } catch (error) {
      importTargetGroupIdRef.current = null
      const failure: ImportFailure = {
        path: selectedFolder ?? '文件夹选择',
        stage: 'scan',
        reason: error instanceof Error ? error.message : String(error),
      }
      setImportSummary({
        scanned: 0,
        added: 0,
        linkedToGroup: 0,
        skipped: 0,
        failed: 1,
        targetGroupId: useSampleStore.getState().activeGroupId,
        failures: [failure],
      })
    } finally {
      if (desktop.runtime !== 'tauri' || !startedTauriImport) {
        useSampleStore.getState().setIsImporting(false)
      }
    }
  }, [isLibraryReadOnly, isUpdateBlocking, runImport])

  const handleRemoveAllImported = useCallback(() => {
    if (isUpdateBlocking || isLibraryReadOnly) return
    const confirmed = window.confirm('确定移除当前导入的全部文件夹和素材吗？\n这不会删除磁盘上的原始文件。')
    if (!confirmed) return

    removeAllImported()
    stopPlayback({ resetTime: true, clearSample: true })
    setCurrentWaveform(null)

    const playerStore = usePlayerStore.getState()
    playerStore.setCurrentSampleId(null)
    playerStore.setCurrentFilePath(null)
    playerStore.setIsPlaying(false)
    playerStore.setCurrentTime(0)
    playerStore.setDuration(0)
    desktop.legacyStorage?.delete('folderState').catch((error) => {
      console.error('删除 folderState 失败', error)
    })
  }, [isLibraryReadOnly, isUpdateBlocking, removeAllImported, stopPlayback])

  const resetLyricsAssemblerState = useCallback(() => {
    setLyricsFilePath('')
    setLyricsTokens([])
    setLyricsSourceGroupId('')
    setLyricsTargetGroupName('')
    setLyricsResult(null)
    setIsAssemblingLyrics(false)
  }, [])

  const handleOpenLyricsAssembler = useCallback(() => {
    if (isLibraryReadOnly) return
    resetLyricsAssemblerState()
    setShowLyricsAssembler(true)
  }, [isLibraryReadOnly, resetLyricsAssemblerState])

  const handleCloseLyricsAssembler = useCallback(() => {
    if (isAssemblingLyrics) return
    setShowLyricsAssembler(false)
  }, [isAssemblingLyrics])

  const handlePickLyricsFile = useCallback(async () => {
    const filePath = await desktop.dialogs.openLyricsFile()
    if (!filePath) return

    const buffer = await desktop.files.readAsBuffer(filePath)
    const text = decodeLyricsText(buffer)
    const tokens = tokenizeLyricsText(text)

    setLyricsFilePath(filePath)
    setLyricsTokens(tokens)
    setLyricsTargetGroupName(getDefaultLyricsGroupName(filePath))
    setLyricsResult(null)
  }, [])

  const handleAssembleLyrics = useCallback(async () => {
    if (!lyricsFilePath || !lyricsSourceGroupId || !lyricsTargetGroupName.trim() || isAssemblingLyrics || isUpdateBlocking || isLibraryReadOnly) {
      return
    }

    const parsedLyricCharCount = lyricsTokens.filter((token): token is Extract<LyricToken, { type: 'char' }> => token.type === 'char').length
    if (parsedLyricCharCount === 0) {
      window.alert('歌词文件里没有可用于活字印刷的汉字。')
      return
    }

    const sourceGroup = groups.get(lyricsSourceGroupId)
    if (!sourceGroup) {
      return
    }

    const sourceSamples = sourceGroup.sampleIds
      .map((sampleId) => samples.get(sampleId))
      .filter((sample): sample is Sample => Boolean(sample && sample.isFileValid))

    if (sourceSamples.length === 0) {
      window.alert('所选源声库分组没有可用素材。')
      return
    }

    setIsAssemblingLyrics(true)
    setLyricsResult(null)

    try {
      const sourceIndex = buildLyricsSourceSampleIndex(sourceSamples)
      const plan = planLyricsAssembly(lyricsTokens, sourceIndex)

      if (plan.matched.length === 0) {
        window.alert(`没有匹配到可生成的素材，缺失 ${plan.missing.length} 个字。请检查源声库分组或素材命名。`)
        return
      }

      const copyResult = await desktop.files.createLyricsFiles({
        targetGroupName: lyricsTargetGroupName.trim(),
        items: plan.matched.map((item) => ({
          id: item.id,
          sourcePath: item.sample.filePath,
          fileName: item.targetFileName,
        })),
      })

      const targetGroupId = uuidv4()
      const matchedMap = new Map(plan.matched.map((item) => [item.id, item]))
      const assembledSamples = copyResult.success
        .map((copied: { id: string; targetPath: string; fileSize: number }): Sample | null => {
          const matched = matchedMap.get(copied.id)
          if (!matched) return null

          const { fileName, fileExt } = getFileNameParts(copied.targetPath)
          const sampleId = uuidv4()

          return {
            id: sampleId,
            fileName,
            fileExt,
            filePath: copied.targetPath,
            folderId: null,
            originalId: sampleId,
            isCopy: false,
            copyIndex: 0,
            duration: matched.sample.duration,
            sampleRate: matched.sample.sampleRate,
            channels: matched.sample.channels,
            fileSize: copied.fileSize || matched.sample.fileSize,
            groupIds: [targetGroupId],
            importedAt: Date.now() + matched.index,
            isDecoded: false,
            isFileValid: true,
          }
        })
        .filter((sample): sample is Sample => sample !== null)

      if (assembledSamples.length === 0) {
        window.alert(`没有成功复制任何素材，复制失败 ${copyResult.failed.length} 个。请检查源文件是否仍然存在。`)
        return
      }

      addGroup({
        id: targetGroupId,
        name: lyricsTargetGroupName.trim(),
        color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`,
        sampleIds: assembledSamples.map((sample) => sample.id),
      })
      addSamples(assembledSamples)
      setActiveGroupId(targetGroupId)

      setLyricsResult({
        successCount: assembledSamples.length,
        missing: plan.missing,
        failedCopies: copyResult.failed.length,
      })

      const resultLines = [
        `活字印刷生成完成：${assembledSamples.length} 个素材`,
        `缺失：${plan.missing.length} 个`,
        `复制失败：${copyResult.failed.length} 个`,
      ]
      if (copyResult.targetDir) {
        resultLines.push(`输出目录：${copyResult.targetDir}`)
      }
      window.alert(resultLines.join('\n'))
      setShowLyricsAssembler(false)
      resetLyricsAssemblerState()
    } catch (error) {
      window.alert('活字印刷生成失败，请检查歌词文件和源声库分组。')
    } finally {
      setIsAssemblingLyrics(false)
    }
  }, [addGroup, addSamples, groups, isAssemblingLyrics, isLibraryReadOnly, isUpdateBlocking, lyricsFilePath, lyricsSourceGroupId, lyricsTargetGroupName, lyricsTokens, resetLyricsAssemblerState, samples, setActiveGroupId])

  // 拖文件到窗口导入
  const handleWindowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (isUpdateBlocking || isLibraryReadOnly || useSampleStore.getState().isImporting) return
    const paths = Array.from(e.dataTransfer.files)
      // @ts-ignore - File in Electron environment has a path property
      .map((f: any) => (f as any).path)
      .filter((p: string) => /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(p))
    if (paths.length > 0) {
      void runImport({ filePaths: paths, scannedFileCount: paths.length })
    }
  }, [isLibraryReadOnly, isUpdateBlocking, runImport])

  useEffect(() => desktop.window.onFilesDropped((droppedPaths) => {
    if (desktop.runtime !== 'tauri' || isUpdateBlocking || isLibraryReadOnly || useSampleStore.getState().isImporting) return
    const filePaths = droppedPaths.filter((path) => /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(path))
    if (!filePaths.length) return
    useSampleStore.getState().setIsImporting(true)
    const targetGroupId = useSampleStore.getState().activeGroupId
    importTargetGroupIdRef.current = targetGroupId
    void desktop.library.startImport({
      filePaths,
      targetGroupId,
    }).then((sessionId) => {
      setCurrentImportSession(sessionId)
      setImportProgress({
        sessionId,
        state: 'scanning',
        discovered: 0,
        processed: 0,
        added: 0,
        duplicates: 0,
        linkedToGroup: 0,
        failed: 0,
        currentPath: null,
        message: null,
      })
    }).catch((error) => {
      importTargetGroupIdRef.current = null
      useSampleStore.getState().setIsImporting(false)
      setImportSummary({
        scanned: filePaths.length,
        added: 0,
        linkedToGroup: 0,
        skipped: 0,
        failed: filePaths.length,
        targetGroupId,
        failures: [{ path: '拖入文件', stage: 'commit', reason: String(error) }],
      })
    })
  }), [desktop, isLibraryReadOnly, isUpdateBlocking])

  // ------------------------------
  // 文件夹操作
  // ------------------------------
  const handleFolderToggle = useCallback((folderId: string) => {
    toggleFolderExpanded(folderId)
  }, [toggleFolderExpanded])

  const handleFolderRename = useCallback((folderId: string, name: string) => {
    renameFolder(folderId, name)
  }, [renameFolder])

  const handleFolderDelete = useCallback((folderId: string) => {
    // 弹出确认对话框
    const folder = folders.get(folderId)
    if (!folder) return
    const folderSamples = useSampleStore.getState().getFolderSamples(folderId)
    const confirmed = window.confirm(`确定删除文件夹 "${folder.name}" 及其中的 ${folderSamples.length} 个样本吗？这不会删除原文件`)
    if (confirmed) {
      removeFolder(folderId)
    }
  }, [folders, removeFolder])

  const handleFolderDragStart = useCallback((e: React.DragEvent, folderId: string) => {
    e.dataTransfer.setData('application/folder-id', folderId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleFolderDragOver = useCallback((e: React.DragEvent, _folderId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleFolderDrop = useCallback((e: React.DragEvent, targetFolderId: string) => {
    e.preventDefault()
    const draggedFolderId = e.dataTransfer.getData('application/folder-id')
    if (!draggedFolderId || draggedFolderId === targetFolderId) return

    const { folderOrder } = useSampleStore.getState()
    const fromIndex = folderOrder.indexOf(draggedFolderId)
    const toIndex = folderOrder.indexOf(targetFolderId)
    if (fromIndex !== -1 && toIndex !== -1) {
      moveFolder(fromIndex, toIndex)
    }
  }, [moveFolder])

  // ------------------------------
  // 播放控制
  // ------------------------------
  const handlePlay = useCallback(async (sample: Sample) => {
    if (!sample.isFileValid) return

    const playerState = usePlayerStore.getState()
    if (playerState.currentSampleId === sample.id && playerState.currentFilePath) {
      await togglePause(sample.id, playerState.currentFilePath)
      const cachedWaveform = getWaveform(sample.id)
      if (cachedWaveform) {
        setCurrentWaveform(cachedWaveform)
      }
      return
    }

    const waveform = await play(sample.id, sample.filePath, 0)
    if (usePlayerStore.getState().currentSampleId !== sample.id) {
      return
    }

    if (waveform) setCurrentWaveform(waveform)
    else {
      const cached = getWaveform(sample.id)
      if (cached) setCurrentWaveform(cached)
    }
  }, [getWaveform, play, togglePause])

  const handlePrimaryPlaybackAction = useCallback(async () => {
    let targetSample = (() => {
      const { selectedIds, samples } = useSampleStore.getState()
      const targetId = selectedIds.values().next().value as string | undefined
      if (!targetId) return null
      return samples.get(targetId) ?? null
    })()

    if (!targetSample && desktop.runtime === 'tauri') {
      const state = useSampleStore.getState()
      const targetId = state.selectedIds.values().next().value as string | undefined
      const summary = targetId ? state.sampleSummaries.get(targetId) : null
      if (summary) {
        await ensureTauriLibraryPage(desktop, summary.pageIndex)
        targetSample = useSampleStore.getState().samples.get(summary.id) ?? null
      }
    }

    if (!targetSample || !targetSample.isFileValid) {
      return
    }

    const playerState = usePlayerStore.getState()
    if (playerState.currentSampleId === targetSample.id && playerState.currentFilePath) {
      await togglePause(targetSample.id, playerState.currentFilePath)

      const cachedWaveform = getWaveform(targetSample.id)
      if (cachedWaveform) {
        setCurrentWaveform(cachedWaveform)
      }
      return
    }

    const waveform = await play(targetSample.id, targetSample.filePath, 0)
    if (usePlayerStore.getState().currentSampleId !== targetSample.id) {
      return
    }

    if (waveform) {
      setCurrentWaveform(waveform)
      return
    }

    const cachedWaveform = getWaveform(targetSample.id)
    if (cachedWaveform) {
      setCurrentWaveform(cachedWaveform)
    }
  }, [desktop, getWaveform, play, togglePause])

  const handleSampleSelect = useCallback((id: string, event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelected(id)
    } else if (event.shiftKey) {
      const { anchorId, getOrderedIds, selectRange } = useSampleStore.getState()
      if (anchorId) selectRange(anchorId, id, getOrderedIds())
    } else {
      setSelected(new Set([id]))
      setAnchorId(id)
    }
  }, [setAnchorId, setSelected, toggleSelected])

  useEffect(() => {
    const previewActive = () => { void handlePrimaryPlaybackAction() }
    const focusList = () => listRef.current?.focus()
    window.addEventListener('otto:preview-active', previewActive)
    window.addEventListener('otto:focus-list', focusList)
    return () => {
      window.removeEventListener('otto:preview-active', previewActive)
      window.removeEventListener('otto:focus-list', focusList)
    }
  }, [handlePrimaryPlaybackAction])

  const handleSeek = useCallback((time: number) => {
    const { currentSampleId, currentFilePath } = usePlayerStore.getState()
    if (currentSampleId && currentFilePath) {
      seekTo(currentSampleId, currentFilePath, time)
    }
  }, [seekTo])

  const handleToggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      clearSelection()
    } else {
      selectAll()
    }
  }, [clearSelection, isAllSelected, selectAll])

  const availableGroups = useMemo(() => Array.from(groups.values()), [groups])
  const lyricCharCount = useMemo(
    () => lyricsTokens.filter((token): token is Extract<LyricToken, { type: 'char' }> => token.type === 'char').length,
    [lyricsTokens]
  )


  // ------------------------------
  // 渲染
  // ------------------------------
  return (
    <div
      className="relative flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 antialiased"
      onDragOver={e => e.preventDefault()}
      onDrop={handleWindowDrop}
    >
      {/* 标题栏 */}
      <TitleBar
        onImportFiles={handleImportFiles}
        onImportFolder={handleImportFolder}
        onAssembleLyrics={handleOpenLyricsAssembler}
        onRemoveAllImported={handleRemoveAllImported}
        isImporting={isImporting || isUpdateBlocking || isLibraryReadOnly}
        updateState={updateState}
        onCheckForUpdates={handleCheckForUpdates}
        onStartUpdate={handleStartUpdate}
      />

      {startupError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">
          <div className="flex items-start justify-between gap-3">
            <span className="whitespace-pre-wrap">{startupError}</span>
            <button
              className="flex-shrink-0 rounded bg-white/10 px-2 py-1 hover:bg-white/15"
              onClick={() => { void navigator.clipboard.writeText(startupError) }}
            >
              复制错误
            </button>
          </div>
        </div>
      )}

      {/* 搜索栏 */}
      <SearchBar />

      {/* 分组筛选栏 */}
      <GroupBar />

      {importSummary && (
        <ImportResultBanner
          summary={importSummary}
          targetGroupName={importSummary.targetGroupId
            ? groups.get(importSummary.targetGroupId)?.name ?? null
            : null}
          onClose={closeImportSummary}
        />
      )}

      {lastUndoSummary && (
        <div className="flex items-center justify-between border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <span>
            已移除新增 {lastUndoSummary.removedSamples} 条、解除归组 {lastUndoSummary.removedGroupLinks} 条、处理目录 {lastUndoSummary.restoredFolders} 个
          </span>
          <button
            className="rounded p-1 hover:bg-white/10"
            aria-label="关闭撤回结果"
            onClick={() => useSampleStore.getState().clearUndoSummary()}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {sampleCount > 0 && (
        <div className="border-b border-white/5 bg-zinc-950 px-3 py-2">
          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-md border border-white/5 bg-transparent px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.035] hover:text-zinc-100">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={isAllSelected}
              onChange={handleToggleSelectAll}
              className="h-3.5 w-3.5"
            />
            <span>全选</span>
          </label>
        </div>
      )}

      {/* 采样列表（虚拟滚动） */}
      <div className="relative flex-1 overflow-hidden bg-zinc-950">
      {selectedIds.size > 1 && !contextMenuTarget && (
        <Suspense fallback={null}>
          <SelectionBar />
        </Suspense>
      )}
      <div
        ref={listRef}
        tabIndex={-1}
        className="h-full overflow-y-auto overflow-x-hidden"
        style={{ contain: 'strict' }}
        onContextMenu={handleListContextMenu}
      >
        {flattenedItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/5 bg-white/[0.025] text-zinc-400">
              <Music2 size={24} />
            </div>
            <div className="text-sm text-zinc-300">
              {sampleCount === 0
                ? '拖入音频文件或点击导入按钮'
                : '没有匹配的采样'}
            </div>
          </div>
        ) : (
          <div
            key={listResetKey}
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualItems.map(virtualRow => {
              const item = flattenedItems[virtualRow.index]
              const isFolder = 'path' in item // SampleFolder has path property
              const isSample = 'filePath' in item // Sample has filePath property
              const isSummary = 'kind' in item && item.kind === 'sample-summary'

              return (
                <div
                  key={isFolder ? `folder_${item.id}` : `sample_${item.id}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${virtualRow.size}px`,
                  }}
                >
                  {isFolder ? (
                    <FolderItem
                      folder={item}
                      isExpanded={expandedFolderIds.has(item.id)}
                      onToggle={handleFolderToggle}
                      onRename={handleFolderRename}
                      onDelete={handleFolderDelete}
                      onDragStart={handleFolderDragStart}
                      onDragOver={handleFolderDragOver}
                      onDrop={handleFolderDrop}
                    />
                  ) : isSample ? (
                    <SampleItem
                      sample={item}
                      isSelected={selectedIds.has(item.id)}
                      isPlaying={currentSampleId === item.id && isPlaying}
                      onPlay={handlePlay}
                      onSelect={handleSampleSelect}
                    />
                  ) : isSummary ? (
                    <div
                      className="flex h-11 items-center gap-2 border-b border-white/5 px-3 text-sm text-zinc-400"
                      style={{ paddingLeft: '28px' }}
                      aria-label={`正在加载 ${item.fileName}${item.fileExt}`}
                    >
                      <Loader2 size={13} className="animate-spin text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-zinc-300">{item.fileName}</span>
                        <span className="ml-0.5 text-xs">{item.fileExt}</span>
                      </span>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {isImporting && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
          <div className="pointer-events-auto flex min-w-64 items-center gap-3 rounded-lg border border-white/5 bg-zinc-950/95 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
            <Loader2 size={20} className="animate-spin text-blue-400" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-text-primary">正在后台导入</span>
              <span className="truncate text-xs text-text-dim">
                {importProgress
                  ? `已处理 ${importProgress.processed} · 新增 ${importProgress.added} · 归组 ${importProgress.linkedToGroup} · 重复 ${importProgress.duplicates}`
                  : '正在准备导入任务…'}
              </span>
            </div>
            {currentImportSession && (
              <button
                className="rounded-md border border-white/10 px-2 py-1 text-xs text-text-secondary hover:bg-white/5"
                onClick={() => void desktop.library.cancelImport(currentImportSession)}
              >
                取消
              </button>
            )}
          </div>
        </div>
      )}
      </div>

      {showLyricsAssembler && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-white/5 bg-zinc-950/95 shadow-lg shadow-black/40 backdrop-blur-xl">
            <div className="flex items-start justify-between border-b border-border-subtle px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-text-primary">活字印刷生成</div>
                <div className="mt-1 text-[11px] text-text-dim">逐字转无声调拼音，并按顺序复制单字素材到新分组</div>
              </div>
              <button
                className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                onClick={handleCloseLyricsAssembler}
                disabled={isAssemblingLyrics}
                title="关闭"
              >
                <X size={15} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="space-y-2">
                <div className="text-xs font-medium text-text-secondary">文本 txt</div>
                <div className="flex items-center gap-2">
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-primary px-3 text-xs font-medium text-white transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={handlePickLyricsFile}
                    disabled={isAssemblingLyrics}
                  >
                    <FileText size={14} />
                    选择 txt
                  </button>
                  <div className="min-w-0 flex-1 truncate text-[11px] text-text-dim">
                    {lyricsFilePath || '未选择歌词文件'}
                  </div>
                </div>
                {lyricsFilePath && (
                  <div className="text-[11px] text-text-dim">
                    已解析 {lyricCharCount} 个汉字 token
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-text-secondary">源声库分组</div>
                <select
                  value={lyricsSourceGroupId}
                  onChange={(e) => setLyricsSourceGroupId(e.target.value)}
                  className="h-9 w-full rounded-md border border-border-subtle bg-bg-elevated px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary"
                  disabled={isAssemblingLyrics}
                >
                  <option value="">请选择已有分组</option>
                  {availableGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.sampleIds.length})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-text-secondary">目标分组名</div>
                <input
                  value={lyricsTargetGroupName}
                  onChange={(e) => setLyricsTargetGroupName(e.target.value)}
                  placeholder="默认取 txt 文件名"
                  className="h-9 w-full rounded-md border border-border-subtle bg-bg-elevated px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-dim focus:border-accent-primary"
                  disabled={isAssemblingLyrics}
                />
              </div>

              {lyricsResult && (
                <div className="space-y-2 rounded-lg border border-border-subtle bg-bg-surface/80 p-3">
                  <div className="text-xs text-text-primary">
                    已生成 {lyricsResult.successCount} 个素材，缺失 {lyricsResult.missing.length} 个，复制失败 {lyricsResult.failedCopies} 个
                  </div>
                  {lyricsResult.missing.length > 0 && (
                    <div className="max-h-28 space-y-1 overflow-y-auto text-[11px] text-text-dim">
                      {lyricsResult.missing.slice(0, 12).map((item) => (
                        <div key={`${item.index}-${item.char}-${item.pinyin}`}>
                          {String(item.index).padStart(3, '0')} - {item.char} - {item.pinyin || '无拼音'}
                        </div>
                      ))}
                      {lyricsResult.missing.length > 12 && (
                        <div>... 其余 {lyricsResult.missing.length - 12} 项未展开</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
              <button
                className="h-8 rounded-md border border-border-subtle bg-bg-surface px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-60"
                onClick={handleCloseLyricsAssembler}
                disabled={isAssemblingLyrics}
              >
                取消
              </button>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-primary px-3 text-xs font-medium text-white transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleAssembleLyrics}
                disabled={isUpdateBlocking || isLibraryReadOnly || isAssemblingLyrics || !lyricsFilePath || !lyricsSourceGroupId || !lyricsTargetGroupName.trim()}
              >
                {isAssemblingLyrics && <Loader2 size={14} className="animate-spin" />}
                <span>{isAssemblingLyrics ? '生成中...' : '开始生成'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 底部状态栏/播放器 */}
      <StatusBar
        waveformData={currentWaveform}
        onSeek={handleSeek}
        onPrimaryAction={handlePrimaryPlaybackAction}
        canControl={canControlPrimarySample}
        isPrimaryPlaying={isPrimarySamplePlaying}
      />
      <ContextMenu />
    </div>
  )
}
