import React, { useCallback } from 'react'
import { Sample } from '@/types'
import { useSampleStore } from '@/store/sampleStore'

interface Props {
  sample: Sample
  isSelected: boolean
  isPlaying: boolean
  onPlay: (sample: Sample) => void
  onSelect: (id: string, e: React.MouseEvent) => void
}

export const SampleItem: React.FC<Props> = ({
  sample,
  isSelected,
  isPlaying,
  onPlay,
  onSelect,
}) => {
  const anchorId = useSampleStore((state) => state.anchorId)
  const getOrderedIds = useSampleStore((state) => state.getOrderedIds)
  const selectRange = useSampleStore((state) => state.selectRange)
  const setSelected = useSampleStore((state) => state.setSelected)
  const selectedIds = useSampleStore((state) => state.selectedIds)
  const folder = useSampleStore((state) => state.getFolderForSample(sample.id))
  const isHidden = useSampleStore((state) => (
    state.hiddenSampleIds.has(sample.id) ||
    Boolean(folder && state.hiddenFolderIds.has(folder.id))
  ))
  const groupNames = useSampleStore((state) => sample.groupIds
    .map((groupId) => state.groups.get(groupId)?.name)
    .filter((name): name is string => Boolean(name)))

  // 点击处理（单击=选中+播放，Shift/Ctrl修饰键=多选）
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && anchorId) {
      const orderedIds = getOrderedIds()
      selectRange(anchorId, sample.id, orderedIds)
    } else {
      onSelect(sample.id, e)
      // 普通点击同时触发播放
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        onPlay(sample)
      }
    }
  }, [sample, anchorId, onSelect, onPlay, getOrderedIds, selectRange])

  // 拖出到DAW
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.preventDefault()

    const { selectedIds } = useSampleStore.getState()
    
    // 如果拖的是选中集合里的一个，则拖出所有选中的
    // 如果拖的不在选中集合里，则只拖这一个
    let dragPaths: string[]
    if (selectedIds.has(sample.id) && selectedIds.size > 1) {
      const { samples } = useSampleStore.getState()
      dragPaths = [...selectedIds]
        .map(id => samples.get(id)?.filePath)
        .filter(Boolean) as string[]
    } else {
      dragPaths = [sample.filePath]
    }
    
    window.electronAPI.dragOutFiles(dragPaths)
  }, [sample])

  // 右键菜单
  const openContextMenu = useSampleStore((state) => state.openContextMenu)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // 如果样本未被选中，则选中它（清空其他选中）
    if (!selectedIds.has(sample.id)) {
      setSelected(new Set([sample.id]))
    }
    openContextMenu('sample', sample.id, e.clientX, e.clientY)
  }, [sample.id, openContextMenu, selectedIds, setSelected])

  // 检查是否隐藏：样本本身隐藏或其所在文件夹隐藏
  const leftPadding = 28 + ((folder?.depth ?? -1) + 1) * 16

  const formatDuration = (s: number) => {
    if (!Number.isFinite(s) || s <= 0) return '--'
    if (s < 1) return `${(s * 1000).toFixed(0)}ms`
    if (s < 60) return `${s.toFixed(2)}s`
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(0).padStart(2, '0')}`
  }

  return (
    <div
      className={`
        flex items-center gap-2 px-3 py-1.5
        cursor-pointer select-none
        border-b border-border
        transition-colors duration-75
        ${isSelected ? 'bg-bg-selected' : 'hover:bg-bg-hover'}
        ${!sample.isFileValid ? 'opacity-40' : ''}
        ${isHidden ? 'text-text-dim opacity-60' : ''}
      `}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={handleDragStart}
      style={{ paddingLeft: `${leftPadding}px` }}
    >
      {/* 选中指示器 */}
      <div className={`
        w-1 h-5 rounded-full flex-shrink-0
        ${isSelected ? 'bg-accent-primary' : 'bg-transparent'}
      `} />

      {/* 播放状态图标 */}
      <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
        {isPlaying ? (
          <span className="text-accent-light text-xs animate-pulse">▶</span>
        ) : (
          <span className="text-text-dim text-xs opacity-0 group-hover:opacity-100">▶</span>
        )}
      </div>

      {/* 文件名 */}
      <span
        className={`flex-1 text-sm truncate font-mono ${isHidden ? 'text-text-dim' : 'text-text-primary'}`}
        title={sample.filePath}  // hover显示完整路径
      >
        {sample.fileName}
        <span className="text-text-dim text-xs">{sample.fileExt}</span>
      </span>

      {/* 分组标签 */}
      <div className="flex gap-1 flex-shrink-0">
        {groupNames.slice(0, 2).map(name => (
          <span
            key={name}
            className="text-xs px-1.5 py-0.5 rounded bg-accent-dim text-accent-light"
          >
            {name}
          </span>
        ))}
      </div>

      {/* 时长 */}
      <span className="text-xs text-text-dim flex-shrink-0 w-16 text-right font-mono">
        {formatDuration(sample.duration)}
      </span>

      {/* 文件丢失提示 */}
      {!sample.isFileValid && (
        <span className="text-xs text-red-400 flex-shrink-0" title="文件已移动或删除">
          ⚠
        </span>
      )}
    </div>
  )
}
