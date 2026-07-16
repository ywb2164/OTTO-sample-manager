import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight, Folder, Trash2 } from 'lucide-react'
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

const FolderItemComponent: React.FC<Props> = ({
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
  const checkboxRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showDeleteButton, setShowDeleteButton] = useState(false)
  const [touchStartX, setTouchStartX] = useState(0)

  const openContextMenu = useSampleStore((state) => state.openContextMenu)
  const setSelected = useSampleStore((state) => state.setSelected)
  const isHidden = useSampleStore((state) => state.hiddenFolderIds.has(folder.id))
  const sampleCount = useSampleStore((state) => state.getFolderSampleCount(folder.id))
  const selectedCount = useSampleStore((state) => state.getFolderSelectedCount(folder.id))

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
    const sampleIds = useSampleStore.getState().getFolderSampleIds(folder.id)
    if (sampleIds.length > 0) {
      setSelected(new Set(sampleIds))
    }
    openContextMenu('folder', folder.id, e.clientX, e.clientY)
  }, [folder.id, openContextMenu, setSelected])

  // 检查文件夹是否隐藏
  const isChecked = sampleCount > 0 && selectedCount === sampleCount
  const isPartiallyChecked = selectedCount > 0 && selectedCount < sampleCount
  const leftPadding = 12 + folder.depth * 16

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = isPartiallyChecked
    }
  }, [isPartiallyChecked])

  const handleCheckboxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation()

    const state = useSampleStore.getState()
    const folderSampleIds = state.getFolderSampleIds(folder.id)
    const nextSelectedIds = new Set(state.selectedIds)
    if (isChecked) {
      folderSampleIds.forEach(id => nextSelectedIds.delete(id))
    } else {
      folderSampleIds.forEach(id => nextSelectedIds.add(id))
    }

    setSelected(nextSelectedIds)
  }, [folder.id, isChecked, setSelected])

  return (
    <div
      className={`
        group flex h-11 items-center gap-2 px-3
        cursor-pointer select-none
        border-b border-white/5
        transition-[background,box-shadow,transform] duration-150
        bg-transparent hover:bg-white/[0.035]
        ${isDragging ? 'scale-[1.01] shadow-xl shadow-black/25' : ''}
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
        ref={checkboxRef}
        type="checkbox"
        checked={isChecked}
        onChange={handleCheckboxChange}
        onClick={(e) => e.stopPropagation()}
        className="h-3.5 w-3.5 flex-shrink-0"
        aria-label={`选择文件夹 ${folder.name}`}
      />

      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-zinc-400">
        {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </div>

      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-blue-300/85">
        <Folder size={15} />
      </div>

      {/* 文件夹名称（可重命名） */}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameConfirm}
          className="min-w-0 flex-1 rounded-md border border-blue-500/45 bg-zinc-900/70 px-2 py-1 text-sm text-zinc-100 outline-none"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium ${isHidden ? 'text-zinc-500' : 'text-zinc-100'}`}
          title={folder.path}
        >
          {folder.name}
        </span>
      )}

      {/* 样本计数 */}
      <span className="flex-shrink-0 text-right text-xs text-zinc-400">
        {sampleCount} 个样本
      </span>

      {/* 左滑删除按钮（仅收起状态） */}
      {!isExpanded && showDeleteButton && (
        <div
          className="absolute bottom-0 right-0 top-0 z-10 flex items-center justify-center gap-1 bg-red-500 px-3 text-xs text-white"
          onClick={handleDeleteClick}
        >
          <Trash2 size={14} />
          <span>删除</span>
        </div>
      )}
    </div>
  )
}

export const FolderItem = React.memo(FolderItemComponent)
