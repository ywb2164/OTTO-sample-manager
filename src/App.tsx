/// <reference types="vite/client" />

import React, { Suspense, useEffect, useCallback, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuidv4 } from 'uuid'

import { TitleBar } from '@/components/TitleBar'
import { SearchBar } from '@/components/SearchBar'
import { GroupBar } from '@/components/GroupBar'
import { SampleItem } from '@/components/SampleList/SampleItem'
import { FolderItem } from '@/components/FolderItem'
import { StatusBar } from '@/components/StatusBar/StatusBar'

import { useSampleStore } from '@/store/sampleStore'
import { usePlayerStore } from '@/store/playerStore'
import { useAudioEngine } from '@/hooks/useAudioEngine'
import { Sample, SampleFolder, ScannedFolderNode, StoredFolderState } from '@/types'
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
  
  const {
    samples, selectedIds,
    addSamples, addGroup, importStructuredData, restoreFolders, removeAllImported, setDecodeProgress,
    toggleSelected, clearSelection, selectAll,
    setAnchorId, setSelected, setActiveGroupId,
    toggleFolderExpanded, renameFolder, removeFolder, moveFolder, getOrderedIds,
    folders, folderOrder, expandedFolderIds
  } = useSampleStore()

  const { currentSampleId, isPlaying } = usePlayerStore()
  const { play, togglePause, seekTo, preDecodeAll, getWaveform, primeDecodedSample, getCacheStats, beginShutdown } = useAudioEngine()
  const folderSettings = useSampleStore(state => state.folderSettings)
  const groups = useSampleStore(state => state.groups)
  const isImporting = useSampleStore(state => state.isImporting)
  const activeGroupId = useSampleStore(state => state.activeGroupId)

  const [currentWaveform, setCurrentWaveform] = useState<Float32Array | null>(null)
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

  const virtualizer = useVirtualizer({
    count: flattenedItems.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,  // 每行高度
    overscan: 10,
  })
  const virtualItems = virtualizer.getVirtualItems()

  const visibleFolderWindowIds = useMemo(() => {
    if (!folderSettings.memoryOptimizationMode || activeGroupId) {
      return []
    }

    const orderedFolderIds = flattenedItems
      .filter((item): item is SampleFolder => 'path' in item)
      .map((folder) => folder.id)

    if (orderedFolderIds.length === 0) {
      return []
    }

    const firstVisibleIndex = virtualItems[0]?.index ?? 0
    let anchorFolderId: string | null = null

    for (let index = Math.min(firstVisibleIndex, flattenedItems.length - 1); index >= 0; index--) {
      const item = flattenedItems[index]
      if (!item) continue

      if ('path' in item) {
        anchorFolderId = item.id
        break
      }

      if ('filePath' in item) {
        const folder = useSampleStore.getState().getFolderForSample(item.id)
        if (folder) {
          anchorFolderId = folder.id
          break
        }
      }
    }

    if (!anchorFolderId) {
      anchorFolderId = orderedFolderIds[0]
    }

    const startIndex = Math.max(0, orderedFolderIds.indexOf(anchorFolderId))
    return orderedFolderIds.slice(startIndex, startIndex + 10)
  }, [activeGroupId, flattenedItems, folderSettings.memoryOptimizationMode, virtualItems])

  const preloadTargets = useMemo(() => {
    if (!hasHydratedStore) {
      return []
    }

    if (folderSettings.memoryOptimizationMode) {
      if (activeGroupId) {
        const group = groups.get(activeGroupId)
        if (!group) return []

        return group.sampleIds
          .map((sampleId) => samples.get(sampleId))
          .filter((sample): sample is Sample => Boolean(sample?.isFileValid))
      }

      const ids = new Set<string>()
      for (const folderId of visibleFolderWindowIds) {
        const folderSamples = useSampleStore.getState().getFolderSamples(folderId)
        folderSamples.forEach((sample) => {
          if (sample.isFileValid) {
            ids.add(sample.id)
          }
        })
      }

      return [...ids]
        .map((sampleId) => samples.get(sampleId))
        .filter((sample): sample is Sample => Boolean(sample))
    }

    return [...samples.values()].filter((sample) => sample.isFileValid)
  }, [activeGroupId, groups, hasHydratedStore, samples, folderSettings.memoryOptimizationMode, visibleFolderWindowIds])

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

      if (storedSettings) {
        const { setExpandOnSearch, setFolderClassificationEnabled, setMemoryOptimizationMode } = useSampleStore.getState()
        if (storedSettings.expandOnSearch !== undefined) {
          setExpandOnSearch(storedSettings.expandOnSearch)
        }
        if (storedSettings.folderClassificationEnabled !== undefined) {
          setFolderClassificationEnabled(storedSettings.folderClassificationEnabled)
        }
        if (storedSettings.memoryOptimizationMode !== undefined) {
          setMemoryOptimizationMode(storedSettings.memoryOptimizationMode)
        }
      }

      if (storedGroups) {
        const { addGroup, groups } = useSampleStore.getState()
        if (groups.size === 0) {
          Object.values(storedGroups).forEach((group: any) => {
            addGroup(group)
          })
        }
      }

      if (!storedSamples) {
        setHasHydratedStore(true)
        return
      }

      const sampleList: Sample[] = Object.values(storedSamples).map(s => ({
        ...s,
        folderId: s.folderId ?? null,
        originalId: s.originalId ?? s.id,
        isCopy: s.isCopy ?? false,
        copyIndex: s.copyIndex ?? 0,
        waveformData: s.waveformData ? new Float32Array(s.waveformData) : undefined,
        isDecoded: false,
        isFileValid: true,  // 先假设有效，后面验证
      }))

      if (sampleList.length === 0) {
        setHasHydratedStore(true)
        return
      }

      // 验证文件是否仍然存在
      const validationResult = await window.electronAPI.validateFiles(
        sampleList.map(s => s.filePath)
      )
      
      const validationMap = new Map<string, boolean>(validationResult.map((r: any) => [r.path, r.valid]))
      const validatedSamples: Sample[] = sampleList.map(s => ({
        ...s,
        isFileValid: validationMap.get(s.filePath) ?? false
      }))

      if (storedFolderState?.folders && storedFolderState.folderOrder) {
        restoreFolders(Object.values(storedFolderState.folders), storedFolderState.folderOrder)
        addSamples(validatedSamples)
      } else {
        addSamples(validatedSamples)
      }

      setHasHydratedStore(true)
    }

    hydrateStore().catch(() => {
      setHasHydratedStore(true)
      setDecodeProgress(null)
      useSampleStore.getState().setIsImporting(false)
    })
  }, [addSamples, restoreFolders, setDecodeProgress])

  useEffect(() => {
    if (!hasHydratedStore || preloadTargets.length === 0) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      preDecodeAll(
        preloadTargets.map((sample) => ({ id: sample.id, filePath: sample.filePath })),
        (current, total) => {
          if (!cancelled) {
            setDecodeProgress({ current, total })
          }
        }
      ).then(() => {
        if (!cancelled) {
          setDecodeProgress(null)
          if (import.meta.env.DEV) {
            console.debug('[cache-stats]', getCacheStats())
          }
        }
      })
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [getCacheStats, hasHydratedStore, preDecodeAll, preloadTargets, setDecodeProgress])

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
      samplesToSave[id] = {
        ...sample,
        // 不保存运行时数据
        waveformData: sample.waveformData ? Array.from(sample.waveformData) : null,
        isDecoded: false,
        isFileValid: true,
      }
    }

    window.electronAPI.storeSet('samples', samplesToSave)
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

    window.electronAPI.storeSet('folderState', folderState)
  }, [folders, folderOrder, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore) {
      return
    }

    const groupsToSave: Record<string, any> = {}
    for (const [id, group] of groups) {
      groupsToSave[id] = group
    }
    window.electronAPI.storeSet('groups', groupsToSave)
  }, [groups, hasHydratedStore])

  useEffect(() => {
    if (!hasHydratedStore) {
      return
    }

    window.electronAPI.storeSet('folderSettings', folderSettings)
  }, [folderSettings, hasHydratedStore])

  // ------------------------------
  // 导入文件
  // ------------------------------
  const importFiles = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0 || useSampleStore.getState().isImporting) return
    useSampleStore.getState().setIsImporting(true)

    const ctx = new AudioContext()
    const newSamples: Sample[] = []
    const existingFilePaths = new Set(Array.from(useSampleStore.getState().samples.values()).map(sample => sample.filePath))
    const targetGroupId = useSampleStore.getState().activeGroupId

    try {
      for (const filePath of filePaths) {
        if (existingFilePaths.has(filePath)) continue

        try {
          const arrayBuffer = await window.electronAPI.readFileAsBuffer(filePath)
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
          const { fileName, fileExt } = getFileNameParts(filePath)

          const sampleId = uuidv4()

          const sample: Sample = {
            id: sampleId,
            fileName,
            fileExt,
            filePath,
            folderId: null,
            originalId: sampleId,
            isCopy: false,
            copyIndex: 0,
            duration: audioBuffer.duration,
            sampleRate: audioBuffer.sampleRate,
            channels: audioBuffer.numberOfChannels,
            fileSize: arrayBuffer.byteLength,
            groupIds: targetGroupId ? [targetGroupId] : [],
            importedAt: Date.now(),
            isDecoded: true,
            isFileValid: true,
          }

          primeDecodedSample(sampleId, audioBuffer)
          newSamples.push(sample)
          existingFilePaths.add(filePath)
        } catch (e) {
          console.error(`导入失败: ${filePath}`, e)
        }
      }

      addSamples(newSamples)

      setDecodeProgress(null)
    } finally {
      ctx.close()
      useSampleStore.getState().setIsImporting(false)
    }
  }, [addSamples, primeDecodedSample, setDecodeProgress])

  const handleImportFiles = useCallback(async () => {
    if (useSampleStore.getState().isImporting) return
    const paths = await window.electronAPI.openFileDialog()
    await importFiles(paths)
  }, [importFiles])

  const handleImportFolder = useCallback(async () => {
    if (useSampleStore.getState().isImporting) return
    const folder = await window.electronAPI.openFolderDialog()
    if (!folder) return
    const scannedRoot = await window.electronAPI.scanFolder(folder)
    if (!scannedRoot) return

    useSampleStore.getState().setIsImporting(true)
    const ctx = new AudioContext()
    const { folders: builtFolders, rootFolderIds } = buildStructuredFolders(scannedRoot)
    const folderMap = new Map(builtFolders.map(folderItem => [folderItem.path, folderItem]))
    const existingFilePaths = new Set(Array.from(useSampleStore.getState().samples.values()).map(sample => sample.filePath))
    const targetGroupId = useSampleStore.getState().activeGroupId
    const newSamples: Sample[] = []

    const collectFiles = (node: ScannedFolderNode): string[] => [
      ...node.files,
      ...node.children.flatMap(collectFiles),
    ]

    try {
      for (const filePath of collectFiles(scannedRoot)) {
        if (existingFilePaths.has(filePath)) continue

        try {
          const arrayBuffer = await window.electronAPI.readFileAsBuffer(filePath)
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
          const { fileName, fileExt } = getFileNameParts(filePath)
          const sampleId = uuidv4()
          const folderPath = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
          const parentFolder = folderMap.get(folderPath)

          const sample: Sample = {
            id: sampleId,
            fileName,
            fileExt,
            filePath,
            folderId: parentFolder?.id ?? null,
            originalId: sampleId,
            isCopy: false,
            copyIndex: 0,
            duration: audioBuffer.duration,
            sampleRate: audioBuffer.sampleRate,
            channels: audioBuffer.numberOfChannels,
            fileSize: arrayBuffer.byteLength,
            groupIds: targetGroupId ? [targetGroupId] : [],
            importedAt: Date.now(),
            isDecoded: true,
            isFileValid: true,
          }

          primeDecodedSample(sampleId, audioBuffer)
          newSamples.push(sample)
          if (parentFolder) {
            parentFolder.sampleIds.push(sampleId)
          }
          existingFilePaths.add(filePath)
        } catch (error) {
          console.error(`导入失败: ${filePath}`, error)
        }
      }

      importStructuredData({
        samples: newSamples,
        folders: builtFolders,
        rootFolderIds,
        targetGroupId,
      })

      setDecodeProgress(null)
    } finally {
      ctx.close()
      useSampleStore.getState().setIsImporting(false)
    }
  }, [importStructuredData, primeDecodedSample, setDecodeProgress])

  const handleRemoveAllImported = useCallback(() => {
    const confirmed = window.confirm('确定移除当前导入的全部文件夹和素材吗？\n这不会删除磁盘上的原始文件。')
    if (!confirmed) return

    removeAllImported()
    setCurrentWaveform(null)

    const playerStore = usePlayerStore.getState()
    playerStore.setCurrentSampleId(null)
    playerStore.setCurrentFilePath(null)
    playerStore.setIsPlaying(false)
    playerStore.setCurrentTime(0)
    playerStore.setDuration(0)
    window.electronAPI.storeDelete('folderState')
  }, [removeAllImported])

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
    if (!lyricsFilePath || !lyricsSourceGroupId || !lyricsTargetGroupName.trim() || isAssemblingLyrics) {
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
      const assembledSamples: Sample[] = copyResult.success
        .map((copied: { id: string; targetPath: string; fileSize: number }) => {
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
          } satisfies Sample
        })
        .filter((sample): sample is Sample => sample !== null)

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
    } catch (error) {
      window.alert('活字印刷生成失败，请检查歌词文件和源声库分组。')
    } finally {
      setIsAssemblingLyrics(false)
    }
  }, [addGroup, addSamples, groups, isAssemblingLyrics, lyricsFilePath, lyricsSourceGroupId, lyricsTargetGroupName, lyricsTokens, samples, setActiveGroupId])

  // 拖文件到窗口导入
  const handleWindowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (useSampleStore.getState().isImporting) return
    const paths = Array.from(e.dataTransfer.files)
      // @ts-ignore - File in Electron environment has a path property
      .map((f: any) => (f as any).path)
      .filter((p: string) => /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(p))
    importFiles(paths)
  }, [importFiles])

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
      // 同时删除文件夹内的所有样本
      const { removeSamples } = useSampleStore.getState()
      removeSamples(folderSamples.map(sample => sample.id))
    }
  }, [folders, removeFolder])

  const handleFolderDragStart = useCallback((e: React.DragEvent, folderId: string) => {
    e.dataTransfer.setData('application/folder-id', folderId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleFolderDragOver = useCallback((e: React.DragEvent, folderId: string) => {
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
    const waveform = await play(sample.id, sample.filePath, 0)
    if (waveform) setCurrentWaveform(waveform)
    else {
      const cached = getWaveform(sample.id)
      if (cached) setCurrentWaveform(cached)
    }
  }, [play, getWaveform])

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

      if (playerState.isPlaying) {
        return
      }

      const cachedWaveform = getWaveform(targetSample.id)
      if (cachedWaveform) {
        setCurrentWaveform(cachedWaveform)
      }
      return
    }

    const waveform = await play(targetSample.id, targetSample.filePath, 0)
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
      className="relative flex flex-col h-screen bg-bg-primary text-text-primary overflow-hidden"
      onDragOver={e => e.preventDefault()}
      onDrop={handleWindowDrop}
    >
      {/* 标题栏 */}
      <TitleBar
        onImportFiles={handleImportFiles}
        onImportFolder={handleImportFolder}
        onAssembleLyrics={handleOpenLyricsAssembler}
        onRemoveAllImported={handleRemoveAllImported}
        isImporting={isImporting}
      />

      {/* 搜索栏 */}
      <SearchBar />

      {/* 分组筛选栏 */}
      <GroupBar />

      {/* 多选操作栏（右键菜单触发显示） */}
      {selectedIds.size > 0 && (
        <Suspense fallback={null}>
          <SelectionBar />
        </Suspense>
      )}

      {samples.size > 0 && (
        <div className="px-3 py-1.5 border-b border-border bg-bg-secondary/60">
          <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer w-fit">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={isAllSelected}
              onChange={handleToggleSelectAll}
              className="w-4 h-4 accent-blue-500"
            />
            <span>全选</span>
          </label>
        </div>
      )}

      {/* 采样列表（虚拟滚动） */}
      <div className="flex-1 relative overflow-hidden">
      <div
        ref={listRef}
        className="h-full overflow-y-auto overflow-x-hidden"
        style={{ contain: 'strict' }}
      >
        {flattenedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-dim">
            <div className="text-4xl">🎵</div>
            <div className="text-sm">
              {samples.size === 0
                ? '拖入音频文件或点击导入按钮'
                : '没有匹配的采样'}
            </div>
          </div>
        ) : (
          <div
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
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-primary/70 backdrop-blur-[1px] pointer-events-auto">
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-bg-secondary/95 shadow-lg">
            <div className="w-5 h-5 border-2 border-accent-primary/30 border-t-accent-primary rounded-full animate-spin" />
            <div className="flex flex-col">
              <span className="text-sm text-text-primary">入飞门中...</span>
              <span className="text-xs text-text-dim">飞马正在8bc, 别急</span>
            </div>
          </div>
        </div>
      )}
      </div>

      {showLyricsAssembler && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-bg-secondary shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <div className="text-sm font-medium text-text-primary">活字印刷生成</div>
                <div className="text-[11px] text-text-dim mt-1">逐字转无声调拼音，并按顺序复制单字素材到新分组</div>
              </div>
              <button
                className="text-text-dim hover:text-text-primary text-sm"
                onClick={handleCloseLyricsAssembler}
                disabled={isAssemblingLyrics}
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="space-y-2">
                <div className="text-xs text-text-primary">文本 txt</div>
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 rounded bg-accent-primary hover:bg-accent-light text-white text-xs disabled:opacity-60"
                    onClick={handlePickLyricsFile}
                    disabled={isAssemblingLyrics}
                  >
                    选择 txt
                  </button>
                  <div className="min-w-0 flex-1 text-[11px] text-text-dim truncate">
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
                <div className="text-xs text-text-primary">源声库分组</div>
                <select
                  value={lyricsSourceGroupId}
                  onChange={(e) => setLyricsSourceGroupId(e.target.value)}
                  className="w-full rounded bg-bg-tertiary border border-border px-3 py-2 text-sm text-text-primary outline-none"
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
                <div className="text-xs text-text-primary">目标分组名</div>
                <input
                  value={lyricsTargetGroupName}
                  onChange={(e) => setLyricsTargetGroupName(e.target.value)}
                  placeholder="默认取 txt 文件名"
                  className="w-full rounded bg-bg-tertiary border border-border px-3 py-2 text-sm text-text-primary outline-none"
                  disabled={isAssemblingLyrics}
                />
              </div>

              {lyricsResult && (
                <div className="rounded-lg border border-border bg-bg-tertiary/70 p-3 space-y-2">
                  <div className="text-xs text-text-primary">
                    已生成 {lyricsResult.successCount} 个素材，缺失 {lyricsResult.missing.length} 个，复制失败 {lyricsResult.failedCopies} 个
                  </div>
                  {lyricsResult.missing.length > 0 && (
                    <div className="max-h-28 overflow-y-auto text-[11px] text-text-dim space-y-1">
                      {lyricsResult.missing.slice(0, 12).map((item) => (
                        <div key={`${item.index}-${item.char}-${item.pinyin}`}>
                          {String(item.index).padStart(3, '0')} · {item.char} · {item.pinyin || '无拼音'}
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

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
              <button
                className="px-3 py-1.5 rounded bg-bg-tertiary hover:bg-bg-hover text-text-primary text-xs disabled:opacity-60"
                onClick={handleCloseLyricsAssembler}
                disabled={isAssemblingLyrics}
              >
                取消
              </button>
              <button
                className="px-3 py-1.5 rounded bg-accent-primary hover:bg-accent-light text-white text-xs disabled:opacity-60"
                onClick={handleAssembleLyrics}
                disabled={isAssemblingLyrics || !lyricsFilePath || !lyricsSourceGroupId || !lyricsTargetGroupName.trim()}
              >
                {isAssemblingLyrics ? '生成中...' : '开始生成'}
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
    </div>
  )
}
