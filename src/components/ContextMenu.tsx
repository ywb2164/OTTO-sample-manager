import React, { useCallback, useEffect, useState } from 'react'
import { useSampleStore } from '@/store/sampleStore'

export const ContextMenu: React.FC = () => {
  const contextMenuTarget = useSampleStore(s => s.contextMenuTarget)
  const closeContextMenu = useSampleStore(s => s.closeContextMenu)
  const toggleSampleHidden = useSampleStore(s => s.toggleSampleHidden)
  const toggleFolderHidden = useSampleStore(s => s.toggleFolderHidden)
  const removeSamples = useSampleStore(s => s.removeSamples)
  const removeFolder = useSampleStore(s => s.removeFolder)
  const groups = useSampleStore(s => s.groups)
  const addToGroup = useSampleStore(s => s.addToGroup)
  const removeFromGroup = useSampleStore(s => s.removeFromGroup)
  const samples = useSampleStore(s => s.samples)

  const [showGroupSubmenu, setShowGroupSubmenu] = useState(false)

  // 点击外部关闭菜单
  useEffect(() => {
    if (!contextMenuTarget) return

    const handleClickOutside = (e: MouseEvent) => {
      // 检查是否点击了菜单外部
      const menuElement = document.getElementById('context-menu')
      if (menuElement && !menuElement.contains(e.target as Node)) {
        closeContextMenu()
      } else if (showGroupSubmenu) {
        // 点击菜单内部但子菜单打开时，可能想关闭子菜单？
        // 这里不处理，让按钮点击处理
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenuTarget, closeContextMenu, showGroupSubmenu])

  if (!contextMenuTarget) return null

  const handleHide = useCallback(() => {
    if (contextMenuTarget.type === 'sample') {
      toggleSampleHidden(contextMenuTarget.id)
    } else {
      toggleFolderHidden(contextMenuTarget.id)
    }
    closeContextMenu()
  }, [contextMenuTarget, toggleSampleHidden, toggleFolderHidden, closeContextMenu])

  const handleRemove = useCallback(() => {
    // 二次确认
    const confirmed = window.confirm(
      contextMenuTarget.type === 'sample'
        ? `确定要移除这个样本吗？\n移除后可以从文件重新导入。`
        : `确定要移除这个文件夹吗？\n文件夹内的所有样本也将被移除。`
    )
    if (confirmed) {
      if (contextMenuTarget.type === 'sample') {
        removeSamples([contextMenuTarget.id])
      } else {
        removeFolder(contextMenuTarget.id)
      }
    }
    closeContextMenu()
  }, [contextMenuTarget, removeSamples, removeFolder, closeContextMenu])

  const handleReturn = useCallback(() => {
    closeContextMenu()
  }, [closeContextMenu])

  const handleGroupAction = useCallback((groupId: string) => {
    if (contextMenuTarget.type === 'sample') {
      const sample = samples.get(contextMenuTarget.id)
      if (!sample) return
      const isInGroup = sample.groupIds.includes(groupId)
      if (isInGroup) {
        removeFromGroup([contextMenuTarget.id], groupId)
      } else {
        addToGroup([contextMenuTarget.id], groupId)
      }
    }
    // 对于文件夹，暂时不处理
    setShowGroupSubmenu(false)
    closeContextMenu()
  }, [contextMenuTarget, samples, addToGroup, removeFromGroup, closeContextMenu])

  const handleGroupSubmenuToggle = useCallback(() => {
    setShowGroupSubmenu(prev => !prev)
  }, [])

  // 计算当前样本的分组信息（仅样本类型）
  const currentSample = contextMenuTarget.type === 'sample' ? samples.get(contextMenuTarget.id) : null
  const sampleGroupIds = currentSample?.groupIds || []
  const groupList = Array.from(groups.values())

  return (
    <div
      id="context-menu"
      className="fixed z-50 bg-bg-elevated border border-border rounded-md shadow-lg min-w-[160px] py-1"
      style={{
        left: `${contextMenuTarget.x}px`,
        top: `${contextMenuTarget.y}px`,
      }}
    >
      <button
        className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-text-primary"
        onClick={handleHide}
      >
        隐藏
      </button>
      <button
        className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-text-primary"
        onClick={handleRemove}
      >
        移除
      </button>

      {/* 分配到分组（仅样本） */}
      {contextMenuTarget.type === 'sample' && (
        <div className="relative">
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-text-primary flex justify-between items-center"
            onClick={handleGroupSubmenuToggle}
          >
            <span>分配到分组</span>
            <span>▶</span>
          </button>
          {showGroupSubmenu && (
            <div className="absolute left-full top-0 ml-1 bg-bg-elevated border border-border rounded-md shadow-lg min-w-[160px] max-h-60 overflow-y-auto py-1 z-50">
              {groupList.length === 0 ? (
                <div className="px-4 py-2 text-sm text-text-dim">暂无分组</div>
              ) : (
                groupList.map(group => {
                  const isInGroup = sampleGroupIds.includes(group.id)
                  return (
                    <button
                      key={group.id}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-text-primary flex items-center gap-2"
                      onClick={() => handleGroupAction(group.id)}
                    >
                      <span className="w-3 h-3 rounded-full border border-border" style={{ backgroundColor: group.color }} />
                      <span className="flex-1">{group.name}</span>
                      {isInGroup && <span className="text-xs text-accent-primary">✓</span>}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      <button
        className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-text-primary"
        onClick={handleReturn}
      >
        返回
      </button>
    </div>
  )
}