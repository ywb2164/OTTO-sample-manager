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
import type {
  ImportCandidate,
  ImportFailure,
  ImportSummary,
  Sample,
  SampleFolder,
  ScannedFolderNode,
  StoredFolderState,
  StoredImportUndoState,
  UpdateState,
} from '@/types'
import { reconcileLibraryState } from '@/services/libraryImport'
import { buildLyricsSourceSampleIndex, planLyricsAssembly } from '@/services/lyricsSampleAssembler'
import { decodeLyricsText, getDefaultLyricsGroupName, tokenizeLyricsText } from '@/services/lyricsPinyinService'
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

const SelectionBar = React.lazy(() =>
  import('@/components/SelectionBar').then((module) => ({ default: module.SelectionBar }))
)

export default function App() {
  const listRef = React.useRef<HTMLDivElement>(null)
  const selectAllRef = React.useRef<HTMLInputElement>(null)
  const groupScrollPositionsRef = React.useRef<Map<string, number>>(new Map())
  const previousGroupScrollKeyRef = React.useRef('__all__')
  const previousSearchQueryRef = React.useRef('')
  
  const {
    samples, selectedIds,
    addSamples, addGroup, commitImport, removeAllImported, setDecodeProgress,
    toggleSelected, clearSelection, selectAll,
    setAnchorId, setSelected, setActiveGroupId,
    toggleFolderExpanded, renameFolder, removeFolder, moveFolder, getOrderedIds,
    folders, folderOrder, expandedFolderIds
  } = useSampleStore()

  const { currentSampleId, isPlaying } = usePlayerStore()
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
  const handleCheckForUpdates = useCallback(() => {
    void window.electronAPI.checkForUpdates({ manual: true }).then(setUpdateState).catch(() => undefined)
  }, [])
  const handleStartUpdate = useCallback(() => {
    void window.electronAPI.startUpdate().catch(() => undefined)
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
      return 'filePath' in item ? `sample-${item.id}` : `folder-${item.id}`
    },
    estimateSize: () => 44,
    overscan: 10,
  })

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
      const storedSamples = await window.electronAPI.storeGet('samples') as Record<string, any> | null
      const storedFolderState = await window.electronAPI.storeGet('folderState') as StoredFolderState | null
      const storedSettings = await window.electronAPI.storeGet('folderSettings') as any
      const storedGroups = await window.electronAPI.storeGet('groups') as Record<string, any> | null
      const storedGroupOrder = await window.electronAPI.storeGet('groupOrder') as string[] | null
      const storedImportUndoState = await window.electronAPI.storeGet('importUndoState') as StoredImportUndoState | null

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
        ? await window.electronAPI.validateFiles(sampleList.map(s => s.filePath))
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

  useEffect(() => {
    let disposed = false
    window.electronAPI.getUpdateState()
      .then((state) => {
        if (!disposed) setUpdateState(state)
      })
      .catch(() => undefined)
    const unsubscribe = window.electronAPI.onUpdateState((state) => {
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
    if (!hasHydratedStore) {
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

    window.electronAPI.storeSet('samples', samplesToSave).catch((error) => {
      console.error('保存 samples 失败', error)
    })
  }, [hasHydratedStore, samples])

  useEffect(() => {
    if (!hasHydratedStore) {
      return
    }

    const folderState: StoredFolderState = {
      folders: {},
      folderOrder,
    }

    for (const [id, folder] of folders) {
      folderState.folders[id] = folder
    }

    window.electronAPI.storeSet('folderState', folderState).catch((error) => {
      console.error('保存 folderState 失败', error)
    })
  }, [folders, folderOrder, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore) {
      return
    }

    const groupsToSave: Record<string, any> = {}
    for (const [id, group] of groups) {
      groupsToSave[id] = group
    }
    window.electronAPI.storeSet('groups', groupsToSave).catch((error) => {
      console.error('保存 groups 失败', error)
    })
  }, [groups, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore) {
      return
    }

    window.electronAPI.storeSet('groupOrder', groupOrder).catch((error) => {
      console.error('保存 groupOrder 失败', error)
    })
  }, [groupOrder, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore) {
      return
    }

    window.electronAPI.storeSet('folderSettings', folderSettings).catch((error) => {
      console.error('保存 folderSettings 失败', error)
    })
  }, [folderSettings, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore) return
    const { libraryRevision, lastImportUndo } = useSampleStore.getState()
    const importUndoState: StoredImportUndoState = {
      libraryRevision,
      receipt: lastImportUndo,
    }
    window.electronAPI.storeSet('importUndoState', importUndoState).catch((error) => {
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
      for (const [index, filePath] of filePaths.entries()) {
        try {
          const fileInfo = await window.electronAPI.getFileInfo(filePath)
          if (!fileInfo?.exists) {
            failures.push({
              path: filePath,
              stage: 'metadata',
              reason: '文件不存在或无法读取',
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
    if (isUpdateBlocking || useSampleStore.getState().isImporting) return
    useSampleStore.getState().setIsImporting(true)

    try {
      const paths = await window.electronAPI.openFileDialog()
      if (paths.length === 0) return
      await runImport({
        filePaths: paths,
        scannedFileCount: paths.length,
        lockAlreadyHeld: true,
      })
    } catch (error) {
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
      useSampleStore.getState().setIsImporting(false)
    }
  }, [isUpdateBlocking, runImport])

  const handleImportFolder = useCallback(async () => {
    if (isUpdateBlocking || useSampleStore.getState().isImporting) return
    useSampleStore.getState().setIsImporting(true)
    let selectedFolder: string | null = null

    try {
      selectedFolder = await window.electronAPI.openFolderDialog()
      if (!selectedFolder) return
      const scanResult = await window.electronAPI.scanFolder(selectedFolder)

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
      useSampleStore.getState().setIsImporting(false)
    }
  }, [isUpdateBlocking, runImport])

  const handleRemoveAllImported = useCallback(() => {
    if (isUpdateBlocking) return
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
    window.electronAPI.storeDelete('folderState').catch((error) => {
      console.error('删除 folderState 失败', error)
    })
  }, [isUpdateBlocking, removeAllImported, stopPlayback])

  const resetLyricsAssemblerState = useCallback(() => {
    setLyricsFilePath('')
    setLyricsTokens([])
    setLyricsSourceGroupId('')
    setLyricsTargetGroupName('')
    setLyricsResult(null)
    setIsAssemblingLyrics(false)
  }, [])

  const handleOpenLyricsAssembler = useCallback(() => {
    resetLyricsAssemblerState()
    setShowLyricsAssembler(true)
  }, [resetLyricsAssemblerState])

  const handleCloseLyricsAssembler = useCallback(() => {
    if (isAssemblingLyrics) return
    setShowLyricsAssembler(false)
  }, [isAssemblingLyrics])

  const handlePickLyricsFile = useCallback(async () => {
    const filePath = await window.electronAPI.openLyricsFileDialog()
    if (!filePath) return

    const buffer = await window.electronAPI.readFileAsBuffer(filePath)
    const text = decodeLyricsText(buffer)
    const tokens = tokenizeLyricsText(text)

    setLyricsFilePath(filePath)
    setLyricsTokens(tokens)
    setLyricsTargetGroupName(getDefaultLyricsGroupName(filePath))
    setLyricsResult(null)
  }, [])

  const handleAssembleLyrics = useCallback(async () => {
    if (!lyricsFilePath || !lyricsSourceGroupId || !lyricsTargetGroupName.trim() || isAssemblingLyrics || isUpdateBlocking) {
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

      const copyResult = await window.electronAPI.createLyricsFiles({
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
  }, [addGroup, addSamples, groups, isAssemblingLyrics, isUpdateBlocking, lyricsFilePath, lyricsSourceGroupId, lyricsTargetGroupName, lyricsTokens, resetLyricsAssemblerState, samples, setActiveGroupId])

  // 拖文件到窗口导入
  const handleWindowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (isUpdateBlocking || useSampleStore.getState().isImporting) return
    const paths = Array.from(e.dataTransfer.files)
      // @ts-ignore - File in Electron environment has a path property
      .map((f: any) => (f as any).path)
      .filter((p: string) => /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(p))
    if (paths.length > 0) {
      void runImport({ filePaths: paths, scannedFileCount: paths.length })
    }
  }, [isUpdateBlocking, runImport])

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
    const targetSample = (() => {
      const { selectedIds, samples } = useSampleStore.getState()
      const targetId = selectedIds.values().next().value as string | undefined
      if (!targetId) return null
      return samples.get(targetId) ?? null
    })()

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
  }, [getWaveform, play, togglePause])

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
        isImporting={isImporting || isUpdateBlocking}
        updateState={updateState}
        onCheckForUpdates={handleCheckForUpdates}
        onStartUpdate={handleStartUpdate}
      />

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
            已移除新增 {lastUndoSummary.removedSamples} 条、解除归组 {lastUndoSummary.removedGroupLinks} 条、恢复目录 {lastUndoSummary.restoredFolders} 个
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

      {samples.size > 0 && (
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
              {samples.size === 0
                ? '拖入音频文件或点击导入按钮'
                : '没有匹配的采样'}
            </div>
          </div>
        ) : (
          <div
            key={listResetKey}
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map(virtualRow => {
              const item = flattenedItems[virtualRow.index]
              const isFolder = 'path' in item // SampleFolder has path property
              const isSample = 'filePath' in item // Sample has filePath property

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
                      onSelect={(id, e) => {
                        if (e.ctrlKey || e.metaKey) {
                          toggleSelected(id)
                        } else if (e.shiftKey) {
                          const { anchorId, getOrderedIds, selectRange } = useSampleStore.getState()
                          if (anchorId) {
                            selectRange(anchorId, id, getOrderedIds())
                          }
                        } else {
                          setSelected(new Set([id]))
                          setAnchorId(id)
                        }
                      }}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {isImporting && (
        <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg border border-white/5 bg-zinc-950/95 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
            <Loader2 size={20} className="animate-spin text-blue-400" />
            <div className="flex flex-col">
              <span className="text-sm text-text-primary">入飞门中...</span>
              <span className="text-xs text-text-dim">飞马正在8bc, 别急</span>
            </div>
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
                disabled={isUpdateBlocking || isAssemblingLyrics || !lyricsFilePath || !lyricsSourceGroupId || !lyricsTargetGroupName.trim()}
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
