import React, { Suspense, useEffect, useCallback, useState } from 'react'
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
    addSamples, importStructuredData, restoreFolders, removeAllImported, setDecodeProgress,
    toggleSelected, clearSelection, selectAll,
    setAnchorId, setSelected,
    toggleFolderExpanded, renameFolder, removeFolder, moveFolder, getOrderedIds,
    folders, folderOrder, expandedFolderIds
  } = useSampleStore()

  const { currentSampleId, isPlaying } = usePlayerStore()
  const { play, togglePause, seekTo, preDecodeAll, getWaveform } = useAudioEngine()
  const folderSettings = useSampleStore(state => state.folderSettings)
  const groups = useSampleStore(state => state.groups)

  const [currentWaveform, setCurrentWaveform] = useState<Float32Array | null>(null)
  const [hasHydratedStore, setHasHydratedStore] = useState(false)

  const orderedIds = getOrderedIds()
  const selectableCount = orderedIds.length
  const selectedVisibleCount = orderedIds.filter(id => selectedIds.has(id)).length
  const isAllSelected = selectableCount > 0 && selectedVisibleCount === selectableCount
  const isPartiallySelected = selectedVisibleCount > 0 && selectedVisibleCount < selectableCount

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
        const { setExpandOnSearch, setFolderClassificationEnabled } = useSampleStore.getState()
        if (storedSettings.expandOnSearch !== undefined) {
          setExpandOnSearch(storedSettings.expandOnSearch)
        }
        if (storedSettings.folderClassificationEnabled !== undefined) {
          setFolderClassificationEnabled(storedSettings.folderClassificationEnabled)
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

      // 后台预解码有效文件
      const validSamples = validatedSamples.filter(s => s.isFileValid)
      preDecodeAll(
        validSamples.map(s => ({ id: s.id, filePath: s.filePath })),
        (current, total) => setDecodeProgress({ current, total })
      ).then(() => setDecodeProgress(null))

      setHasHydratedStore(true)
    }

    hydrateStore().catch(() => {
      setHasHydratedStore(true)
      setDecodeProgress(null)
      useSampleStore.getState().setIsImporting(false)
    })
  }, [addSamples, preDecodeAll, restoreFolders, setDecodeProgress])

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
    if (filePaths.length === 0) return
    useSampleStore.getState().setIsImporting(true)

    const ctx = new AudioContext()
    const newSamples: Sample[] = []
    const existingFilePaths = new Set(Array.from(useSampleStore.getState().samples.values()).map(sample => sample.filePath))
    const targetGroupId = useSampleStore.getState().activeGroupId

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

        newSamples.push(sample)
        existingFilePaths.add(filePath)
      } catch (e) {
        console.error(`导入失败: ${filePath}`, e)
      }
    }

    ctx.close()
    addSamples(newSamples)
    useSampleStore.getState().setIsImporting(false)

    // 后台预解码
    preDecodeAll(
      newSamples.map(s => ({ id: s.id, filePath: s.filePath })),
      (current, total) => setDecodeProgress({ current, total })
    ).then(() => setDecodeProgress(null))
  }, [addSamples, preDecodeAll, setDecodeProgress])

  const handleImportFiles = useCallback(async () => {
    const paths = await window.electronAPI.openFileDialog()
    await importFiles(paths)
  }, [importFiles])

  const handleImportFolder = useCallback(async () => {
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

      preDecodeAll(
        newSamples.map(s => ({ id: s.id, filePath: s.filePath })),
        (current, total) => setDecodeProgress({ current, total })
      ).then(() => setDecodeProgress(null))
    } finally {
      ctx.close()
      useSampleStore.getState().setIsImporting(false)
    }
  }, [importStructuredData, preDecodeAll, setDecodeProgress])

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

  // 拖文件到窗口导入
  const handleWindowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
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
    const confirmed = window.confirm(`确定删除文件夹 "${folder.name}" 及其中的 ${folderSamples.length} 个样本吗？`)
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

  const handleTogglePause = useCallback(() => {
    const { currentSampleId, currentFilePath } = usePlayerStore.getState()
    if (currentSampleId && currentFilePath) {
      togglePause(currentSampleId, currentFilePath)
    }
  }, [togglePause])

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


  // ------------------------------
  // 渲染
  // ------------------------------
  return (
    <div
      className="flex flex-col h-screen bg-bg-primary text-text-primary overflow-hidden"
      onDragOver={e => e.preventDefault()}
      onDrop={handleWindowDrop}
    >
      {/* 标题栏 */}
      <TitleBar
        onImportFiles={handleImportFiles}
        onImportFolder={handleImportFolder}
        onRemoveAllImported={handleRemoveAllImported}
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
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
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

      {/* 底部状态栏/播放器 */}
      <StatusBar
        waveformData={currentWaveform}
        onSeek={handleSeek}
        onTogglePause={handleTogglePause}
      />
    </div>
  )
}
