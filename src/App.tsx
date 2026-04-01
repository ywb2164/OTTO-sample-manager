import React, { useEffect, useCallback, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { v4 as uuidv4 } from 'uuid'  // npm install uuid @types/uuid

import { TitleBar } from '@/components/TitleBar'
import { SearchBar } from '@/components/SearchBar'
import { GroupBar } from '@/components/GroupBar'
import { SampleItem } from '@/components/SampleList/SampleItem'
import { FolderItem } from '@/components/FolderItem'
import { SelectionBar } from '@/components/SelectionBar'
import { StatusBar } from '@/components/StatusBar/StatusBar'
import { ContextMenu } from '@/components/ContextMenu'

import { useSampleStore } from '@/store/sampleStore'
import { usePlayerStore } from '@/store/playerStore'
import { useAudioEngine } from '@/hooks/useAudioEngine'
import { Sample } from '@/types'

export default function App() {
  const listRef = React.useRef<HTMLDivElement>(null)
  
  const {
    samples, selectedIds,
    addSamples, setDecodeProgress,
    toggleSelected, clearSelection, selectAll,
    setAnchorId, setSelected,
    toggleFolderExpanded, renameFolder, removeFolder, moveFolder,
    folders, expandedFolderIds, getFolderByPath
  } = useSampleStore()

  const { currentSampleId, isPlaying } = usePlayerStore()
  const { play, togglePause, seekTo, preDecodeAll, getWaveform } = useAudioEngine()
  const folderSettings = useSampleStore(state => state.folderSettings)
  const showSelectionBar = useSampleStore(state => state.showSelectionBar)
  const groups = useSampleStore(state => state.groups)

  const [currentWaveform, setCurrentWaveform] = useState<Float32Array | null>(null)

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

  // ------------------------------
  // 数据持久化：启动时恢复
  // ------------------------------
  useEffect(() => {
    const restore = async () => {
      const storedSamples = await window.electronAPI.storeGet('samples') as Record<string, any> | null
      if (!storedSamples) return

      const sampleList: Sample[] = Object.values(storedSamples).map(s => ({
        ...s,
        waveformData: s.waveformData ? new Float32Array(s.waveformData) : undefined,
        isDecoded: false,
        isFileValid: true,  // 先假设有效，后面验证
      }))

      if (sampleList.length === 0) return

      // 验证文件是否仍然存在
      const validationResult = await window.electronAPI.validateFiles(
        sampleList.map(s => s.filePath)
      )
      
      const validationMap = new Map<string, boolean>(validationResult.map((r: any) => [r.path, r.valid]))
      const validatedSamples: Sample[] = sampleList.map(s => ({
        ...s,
        isFileValid: validationMap.get(s.filePath) ?? false
      }))

      addSamples(validatedSamples)

      // 后台预解码有效文件
      const validSamples = validatedSamples.filter(s => s.isFileValid)
      preDecodeAll(
        validSamples.map(s => ({ id: s.id, filePath: s.filePath })),
        (current, total) => setDecodeProgress({ current, total })
      ).then(() => setDecodeProgress(null))
    }

    restore()
  }, [])

  // ------------------------------
  // 持久化：恢复设置
  // ------------------------------
  useEffect(() => {
    const restoreSettings = async () => {
      const storedSettings = await window.electronAPI.storeGet('folderSettings') as any
      if (!storedSettings) return

      const { setExpandOnSearch, setFolderClassificationEnabled } = useSampleStore.getState()
      if (storedSettings.expandOnSearch !== undefined) {
        setExpandOnSearch(storedSettings.expandOnSearch)
      }
      if (storedSettings.folderClassificationEnabled !== undefined) {
        setFolderClassificationEnabled(storedSettings.folderClassificationEnabled)
      }
    }
    restoreSettings()
  }, [])

  // ------------------------------
  // 持久化：恢复分组
  // ------------------------------
  useEffect(() => {
    const restoreGroups = async () => {
      const storedGroups = await window.electronAPI.storeGet('groups') as Record<string, any> | null
      if (!storedGroups) return

      const { addGroup } = useSampleStore.getState()
      // 清空现有分组（如果有的话）
      const { groups } = useSampleStore.getState()
      if (groups.size > 0) {
        // 通常启动时groups为空，但以防万一
        console.log('跳过恢复分组，因为已有分组存在')
        return
      }
      // 添加所有分组
      Object.values(storedGroups).forEach((group: any) => {
        addGroup(group)
      })
      console.log('恢复分组:', Object.keys(storedGroups).length)
    }
    restoreGroups()
  }, [])

  // ------------------------------
  // 持久化：保存到store
  // ------------------------------
  useEffect(() => {
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
  }, [samples])

  // ------------------------------
  // 持久化：保存分组
  // ------------------------------
  useEffect(() => {
    const groupsToSave: Record<string, any> = {}
    for (const [id, group] of groups) {
      groupsToSave[id] = group
    }
    window.electronAPI.storeSet('groups', groupsToSave)
  }, [groups])

  // ------------------------------
  // 持久化：保存设置
  // ------------------------------
  useEffect(() => {
    window.electronAPI.storeSet('folderSettings', folderSettings)
  }, [folderSettings])

  // ------------------------------
  // 导入文件
  // ------------------------------
  const importFiles = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0) return
    useSampleStore.getState().setIsImporting(true)

    const ctx = new AudioContext()
    const newSamples: Sample[] = []

    for (const filePath of filePaths) {
      // 检查是否已导入（路径去重）
      const alreadyImported = [...samples.values()].some(s => s.filePath === filePath)
      if (alreadyImported) continue

      try {
        const fileInfo = await window.electronAPI.getFileInfo(filePath)
        if (!fileInfo.exists) continue

        // 读取文件解码获取时长等元数据
        const arrayBuffer = await window.electronAPI.readFileAsBuffer(filePath)
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))

        // 提取文件名
        const pathParts = filePath.replace(/\\/g, '/').split('/')
        const fullFileName = pathParts[pathParts.length - 1]
        const dotIndex = fullFileName.lastIndexOf('.')
        const fileName = dotIndex > 0 ? fullFileName.substring(0, dotIndex) : fullFileName
        const fileExt = dotIndex > 0 ? fullFileName.substring(dotIndex) : ''

        const sample: Sample = {
          id: uuidv4(),
          fileName,
          fileExt,
          filePath,
          duration: audioBuffer.duration,
          sampleRate: audioBuffer.sampleRate,
          channels: audioBuffer.numberOfChannels,
          fileSize: fileInfo.fileSize,
          groupIds: [],
          importedAt: Date.now(),
          isDecoded: true,
          isFileValid: true,
        }

        newSamples.push(sample)
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
  }, [samples, addSamples, preDecodeAll])

  const handleImportFiles = useCallback(async () => {
    const paths = await window.electronAPI.openFileDialog()
    await importFiles(paths)
  }, [importFiles])

  const handleImportFolder = useCallback(async () => {
    const folder = await window.electronAPI.openFolderDialog()
    if (!folder) return
    const paths = await window.electronAPI.scanFolder(folder)
    await importFiles(paths)
  }, [importFiles])

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
    const confirmed = window.confirm(`确定删除文件夹 "${folder.name}" 及其中的 ${folder.sampleIds.length} 个样本吗？`)
    if (confirmed) {
      removeFolder(folderId)
      // 同时删除文件夹内的所有样本
      const { removeSamples } = useSampleStore.getState()
      removeSamples(folder.sampleIds)
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

  // ------------------------------
  // 键盘快捷键
  // ------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+A 全选
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault()
        selectAll()
      }
      // Delete 删除选中
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (document.activeElement?.tagName === 'INPUT') return
        const { selectedIds, removeSamples } = useSampleStore.getState()
        if (selectedIds.size > 0) {
          removeSamples([...selectedIds])
        }
      }
      // Escape 清除选中
      if (e.key === 'Escape') {
        clearSelection()
      }
      // 空格键 暂停/播放
      if (e.key === ' ') {
        if (document.activeElement?.tagName === 'INPUT') return
        e.preventDefault()
        handleTogglePause()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectAll, clearSelection, handleTogglePause])

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
      />

      {/* 搜索栏 */}
      <SearchBar />

      {/* 分组筛选栏 */}
      <GroupBar />

      {/* 多选操作栏（右键菜单触发显示） */}
      {showSelectionBar && selectedIds.size > 0 && <SelectionBar />}

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
