import React, { useCallback, useEffect, useState } from 'react'
import { EyeOff, Layers3, RotateCcw, Trash2, Check, ChevronRight } from 'lucide-react'
import { useSampleStore } from '@/store/sampleStore'
import { getDesktopBridgeIfAvailable } from '@/services/desktopBridge'

export const ContextMenu: React.FC = () => {
  const desktop = getDesktopBridgeIfAvailable()
  const isTauri = desktop?.runtime === 'tauri'
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
  const sampleSummaries = useSampleStore(s => s.sampleSummaries)
  const getFolderSampleIds = useSampleStore(s => s.getFolderSampleIds)
  const lastImportUndo = useSampleStore(s => s.lastImportUndo)
  const undoLastImport = useSampleStore(s => s.undoLastImport)

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

  useEffect(() => {
    setShowGroupSubmenu(false)
  }, [contextMenuTarget])

  const handleHide = useCallback(() => {
    if (!contextMenuTarget) return

    if (contextMenuTarget.type === 'sample') {
      toggleSampleHidden(contextMenuTarget.id)
    } else {
      toggleFolderHidden(contextMenuTarget.id)
    }
    closeContextMenu()
  }, [contextMenuTarget, toggleSampleHidden, toggleFolderHidden, closeContextMenu])

  const handleRemove = useCallback(() => {
    if (!contextMenuTarget) return

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

  const handleUndoImport = useCallback(async () => {
    if (!isTauri && !lastImportUndo) return
    const confirmed = window.confirm(
      '确定撤回上次导入吗？\n这只会移除管理器中的新增记录和归组关系，不会删除磁盘文件。',
    )
    if (confirmed) {
      if (isTauri && desktop) {
        const summary = await desktop.library.undoLastImport()
        if (summary) {
          useSampleStore.setState({
            lastUndoSummary: {
              removedSamples: summary.removedSamples,
              removedGroupLinks: summary.removedGroupLinks,
              restoredFolders: summary.removedFolders,
            },
          })
          window.dispatchEvent(new CustomEvent('otto:library-changed'))
        }
      } else {
        undoLastImport()
      }
    }
    closeContextMenu()
  }, [desktop, isTauri, lastImportUndo, undoLastImport, closeContextMenu])

  const handleGroupAction = useCallback((groupId: string) => {
    if (!contextMenuTarget) return

    const targetSampleIds = contextMenuTarget.type === 'sample'
      ? (samples.has(contextMenuTarget.id) || sampleSummaries.has(contextMenuTarget.id)) ? [contextMenuTarget.id] : []
      : getFolderSampleIds(contextMenuTarget.id)

    if (targetSampleIds.length === 0) {
      setShowGroupSubmenu(false)
      closeContextMenu()
      return
    }

    const allInGroup = targetSampleIds.every((sampleId) =>
      (samples.get(sampleId)?.groupIds ?? sampleSummaries.get(sampleId)?.groupIds ?? []).includes(groupId),
    )

    if (allInGroup) {
      removeFromGroup(targetSampleIds, groupId)
    } else {
      addToGroup(targetSampleIds, groupId)
    }

    setShowGroupSubmenu(false)
    closeContextMenu()
  }, [contextMenuTarget, samples, sampleSummaries, getFolderSampleIds, addToGroup, removeFromGroup, closeContextMenu])

  const handleGroupSubmenuToggle = useCallback(() => {
    setShowGroupSubmenu(prev => !prev)
  }, [])

  // 计算当前样本的分组信息（仅样本类型）
  const targetSampleIds = contextMenuTarget
      ? contextMenuTarget.type === 'sample'
      ? (samples.has(contextMenuTarget.id) || sampleSummaries.has(contextMenuTarget.id)) ? [contextMenuTarget.id] : []
      : contextMenuTarget.type === 'folder'
        ? getFolderSampleIds(contextMenuTarget.id)
        : []
    : []
  const groupTargetLabel = contextMenuTarget?.type === 'folder' ? '分配文件夹到分组' : '分配到分组'
  const groupTargetSampleCount = targetSampleIds.length
  const groupList = Array.from(groups.values())

  if (!contextMenuTarget) return null

  if (contextMenuTarget.type === 'background') {
    const label = lastImportUndo
      ? `撤回上次导入（新增 ${lastImportUndo.summary.added} / 归组 ${lastImportUndo.summary.linkedToGroup}）`
      : isTauri ? '撤回上次导入' : '暂无可撤回导入'

    return (
      <div
        id="context-menu"
        className="fixed z-[100] min-w-[220px] rounded-lg border border-white/5 bg-zinc-950/95 py-1.5 shadow-lg shadow-black/30 backdrop-blur-xl"
        style={{ left: `${contextMenuTarget.x}px`, top: `${contextMenuTarget.y}px` }}
      >
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors enabled:hover:bg-bg-hover disabled:cursor-not-allowed disabled:text-text-dim"
          disabled={!isTauri && !lastImportUndo}
          onClick={() => { void handleUndoImport() }}
        >
          <RotateCcw size={14} />
          <span>{label}</span>
        </button>
      </div>
    )
  }

  return (
    <div
      id="context-menu"
      className="fixed z-[100] min-w-[170px] rounded-lg border border-white/5 bg-zinc-950/95 py-1.5 shadow-lg shadow-black/30 backdrop-blur-xl"
      style={{
        left: `${contextMenuTarget.x}px`,
        top: `${contextMenuTarget.y}px`,
      }}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover"
        onClick={handleHide}
      >
        <EyeOff size={14} />
        <span>隐藏</span>
      </button>
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10"
        onClick={handleRemove}
      >
        <Trash2 size={14} />
        <span>移除</span>
      </button>

      {/* 分配到分组 */}
      {(contextMenuTarget.type === 'sample' || groupTargetSampleCount > 0) && (
        <div className="relative">
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover"
            onClick={handleGroupSubmenuToggle}
          >
            <Layers3 size={14} />
            <span className="flex-1">{groupTargetLabel}</span>
            <ChevronRight size={13} className="text-text-muted" />
          </button>
          {showGroupSubmenu && (
            <div className="absolute left-full top-0 z-[100] ml-2 max-h-60 min-w-[170px] overflow-y-auto rounded-lg border border-white/5 bg-zinc-950/95 py-1.5 shadow-lg shadow-black/30 backdrop-blur-xl">
              {groupList.length === 0 ? (
                <div className="px-3 py-2 text-xs text-text-dim">暂无分组</div>
              ) : (
                groupList.map(group => {
                  const isInGroup = targetSampleIds.length > 0 && targetSampleIds.every((sampleId) =>
                    (samples.get(sampleId)?.groupIds ?? sampleSummaries.get(sampleId)?.groupIds ?? []).includes(group.id),
                  )
                  return (
                    <button
                      key={group.id}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover"
                      onClick={() => handleGroupAction(group.id)}
                    >
                      <span className="h-2.5 w-2.5 rounded-full border border-white/20" style={{ backgroundColor: group.color }} />
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                      {isInGroup && <Check size={13} className="text-accent-light" />}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        onClick={handleReturn}
      >
        <RotateCcw size={14} />
        <span>返回</span>
      </button>
    </div>
  )
}
