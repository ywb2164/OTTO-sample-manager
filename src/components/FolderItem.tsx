import React, { useState, useRef, useEffect, useCallback } from 'react'
import { SampleFolder } from '@/types'
import { useSampleStore } from '@/store/sampleStore'

interface Props {
  folder: SampleFolder
  isExpanded: boolean
  onToggle: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onDragStart: (e: React.DragEvent, folderId: string) => void
  onDragOver: (e: React.DragEvent, folderId: string) => void
  onDrop: (e: React.DragEvent, folderId: string) => void
}

export const FolderItem: React.FC<Props> = ({
  folder,
  isExpanded,
  onToggle,
  onRename,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}) => {
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.name)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showDeleteButton, setShowDeleteButton] = useState(false)
  const [touchStartX, setTouchStartX] = useState(0)

  const { getFolderSamples, openContextMenu, hiddenFolderIds, setSelected, selectedIds } = useSampleStore()

  // 双击进入重命名模式
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isExpanded) {
      setIsRenaming(true)
      setRenameValue(folder.name)
    }
  }, [folder.name, isExpanded])

  // 重命名确认
  const handleRenameConfirm = useCallback(() => {
    if (renameValue.trim() && renameValue !== folder.name) {
      onRename(folder.id, renameValue.trim())
    }
    setIsRenaming(false)
  }, [folder.id, folder.name, onRename, renameValue])

  // 重命名取消
  const handleRenameCancel = useCallback(() => {
    setIsRenaming(false)
    setRenameValue(folder.name)
  }, [folder.name])

  // 点击展开/收起
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isRenaming) {
      return
    }
    e.stopPropagation()
    onToggle(folder.id)
  }, [folder.id, onToggle, isExpanded, isRenaming])

  // 键盘事件处理重命名
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isRenaming) {
        if (e.key === 'Enter') {
          handleRenameConfirm()
        } else if (e.key === 'Escape') {
          handleRenameCancel()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isRenaming, handleRenameConfirm, handleRenameCancel])

  // 重命名输入框聚焦
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  // 长按拖拽检测（500ms）
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return // 仅左键
    const timer = setTimeout(() => {
      setIsDragging(true)
    }, 500)
    const onMouseUp = () => clearTimeout(timer)
    window.addEventListener('mouseup', onMouseUp, { once: true })
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    setTouchStartX(touch.clientX)
    const timer = setTimeout(() => {
      setIsDragging(true)
    }, 500)
    const onTouchEnd = () => clearTimeout(timer)
    window.addEventListener('touchend', onTouchEnd, { once: true })
  }, [])

  // 拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!isDragging) {
      e.preventDefault()
      return
    }
    onDragStart(e, folder.id)
    setIsDragging(false)
  }, [folder.id, isDragging, onDragStart])

  // 左滑删除检测（仅收起状态）
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (isExpanded) return
    const touch = e.touches[0]
    const deltaX = touch.clientX - touchStartX
    if (deltaX < -30) { // 左滑超过30px
      setShowDeleteButton(true)
    } else if (deltaX > 10) {
      setShowDeleteButton(false)
    }
  }, [isExpanded, touchStartX])

  const handleTouchEnd = useCallback(() => {
    if (showDeleteButton) {
      // 保持删除按钮显示
    } else {
      setShowDeleteButton(false)
    }
  }, [showDeleteButton])

  // 点击删除按钮
  const handleDeleteClick = useCallback(() => {
    onDelete(folder.id)
  }, [folder.id, onDelete])

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // 选中文件夹内的所有样本
    const folderSamples = getFolderSamples(folder.id)
    const sampleIds = folderSamples.map(s => s.id)
    if (sampleIds.length > 0) {
      setSelected(new Set(sampleIds))
    }
    openContextMenu('folder', folder.id, e.clientX, e.clientY)
  }, [folder.id, openContextMenu, getFolderSamples, setSelected])

  // 检查文件夹是否隐藏
  const isHidden = hiddenFolderIds.has(folder.id)

  const folderSamples = getFolderSamples(folder.id)
  const sampleCount = folderSamples.length
  const folderSampleIds = folderSamples.map(sample => sample.id)
  const isChecked = folderSampleIds.length > 0 && folderSampleIds.every(id => selectedIds.has(id))
  const leftPadding = 12 + folder.depth * 16

  const handleCheckboxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation()

    const nextSelectedIds = new Set(selectedIds)
    if (isChecked) {
      folderSampleIds.forEach(id => nextSelectedIds.delete(id))
    } else {
      folderSampleIds.forEach(id => nextSelectedIds.add(id))
    }

    setSelected(nextSelectedIds)
  }, [folderSampleIds, isChecked, selectedIds, setSelected])

  return (
    <div
      className={`
        flex items-center gap-2 px-3 py-1.5
        cursor-pointer select-none
        border-b border-border
        transition-colors duration-75
        bg-bg-secondary hover:bg-bg-hover
        ${isDragging ? 'opacity-50' : ''}
        ${isHidden ? 'text-text-dim opacity-60' : ''}
        relative overflow-hidden
      `}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      draggable={isDragging}
      onDragStart={handleDragStart}
      onDragOver={(e) => onDragOver(e, folder.id)}
      onDrop={(e) => onDrop(e, folder.id)}
      style={{ paddingLeft: `${leftPadding}px` }}
    >
      <input
        type="checkbox"
        checked={isChecked}
        onChange={handleCheckboxChange}
        onClick={(e) => e.stopPropagation()}
        className="w-4 h-4 flex-shrink-0 accent-blue-500"
        aria-label={`选择文件夹 ${folder.name}`}
      />

      {/* 展开/收起箭头 */}
      <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
        {isExpanded ? (
          <span className="text-text-dim text-xs">▼</span>
        ) : (
          <span className="text-text-dim text-xs">▶</span>
        )}
      </div>

      {/* 文件夹图标 */}
      <div className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
        <span className="text-text-dim text-xs">📁</span>
      </div>

      {/* 文件夹名称（可重命名） */}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameConfirm}
          className="flex-1 text-sm bg-bg-primary text-text-primary border border-accent-primary rounded px-1"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={`flex-1 text-sm truncate ${isHidden ? 'text-text-dim' : 'text-text-primary'}`}
          title={folder.path}
        >
          {folder.name}
        </span>
      )}

      {/* 样本计数 */}
      <span className="text-xs text-text-dim flex-shrink-0">
        {sampleCount} 个样本
      </span>

      {/* 左滑删除按钮（仅收起状态） */}
      {!isExpanded && showDeleteButton && (
        <div
          className="absolute right-0 top-0 bottom-0 flex items-center justify-center bg-red-500 text-white px-3 z-10"
          onClick={handleDeleteClick}
        >
          删除
        </div>
      )}
    </div>
  )
}
