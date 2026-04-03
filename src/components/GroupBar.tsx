import React, { useState } from 'react'
import { useSampleStore } from '@/store/sampleStore'
import { v4 as uuidv4 } from 'uuid'

export const GroupBar: React.FC = () => {
  const groups = useSampleStore((state) => state.groups)
  const activeGroupId = useSampleStore((state) => state.activeGroupId)
  const setActiveGroupId = useSampleStore((state) => state.setActiveGroupId)
  const addGroup = useSampleStore((state) => state.addGroup)
  const renameGroup = useSampleStore((state) => state.renameGroup)
  const removeGroup = useSampleStore((state) => state.removeGroup)

  const [isCreatingGroup, setIsCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const [contextMenu, setContextMenu] = useState<{groupId: string; x: number; y: number} | null>(null)

  const handleSelectGroup = (groupId: string | null) => {
    setActiveGroupId(groupId)
  }

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return

    const newGroup = {
      id: uuidv4(),
      name: newGroupName.trim(),
      color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`,
      sampleIds: []
    }

    addGroup(newGroup)
    setNewGroupName('')
    setIsCreatingGroup(false)
    setActiveGroupId(newGroup.id)
  }

  const handleStartEdit = (groupId: string, currentName: string) => {
    setEditingGroupId(groupId)
    setEditingGroupName(currentName)
  }

  const handleSaveEdit = () => {
    if (editingGroupId && editingGroupName.trim()) {
      renameGroup(editingGroupId, editingGroupName.trim())
    }
    setEditingGroupId(null)
    setEditingGroupName('')
  }

  const handleDeleteGroup = (groupId: string) => {
    const group = groups.get(groupId)
    if (!group) return

    if (group.sampleIds.length > 0) {
      const confirmed = window.confirm(
        `分组 "${group.name}" 中包含 ${group.sampleIds.length} 个样本。确定要删除这个分组吗？\n分组删除后，样本不会被删除，只会从分组中移除。`
      )
      if (!confirmed) return
    } else {
      const confirmed = window.confirm(`确定要删除分组 "${group.name}" 吗？`)
      if (!confirmed) return
    }

    removeGroup(groupId)
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
    }
  }

  const handleGroupContextMenu = (e: React.MouseEvent, groupId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      groupId,
      x: e.clientX,
      y: e.clientY
    })
  }

  const handleEditFromContextMenu = (groupId: string) => {
    const group = groups.get(groupId)
    if (group) {
      handleStartEdit(groupId, group.name)
    }
    setContextMenu(null)
  }

  const handleDeleteFromContextMenu = (groupId: string) => {
    handleDeleteGroup(groupId)
    setContextMenu(null)
  }

  // 点击外部关闭上下文菜单
  React.useEffect(() => {
    const handleClickOutside = () => {
      setContextMenu(null)
    }
    document.addEventListener('click', handleClickOutside)
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [])

  return (
    <div className="p-2 border-b border-border-primary flex items-center gap-2 overflow-x-auto">
      <button
        onClick={() => handleSelectGroup(null)}
        className={`px-3 py-1 rounded text-sm whitespace-nowrap ${
          activeGroupId === null
            ? 'bg-bg-secondary text-text-primary'
            : 'bg-bg-tertiary text-text-secondary hover:bg-bg-secondary'
        }`}
      >
        全部
      </button>

      {Array.from(groups.values()).map((group) => (
        <div key={group.id} className="relative">
          {editingGroupId === group.id ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={editingGroupName}
                onChange={(e) => setEditingGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveEdit()
                  if (e.key === 'Escape') {
                    setEditingGroupId(null)
                    setEditingGroupName('')
                  }
                }}
                className="px-3 py-1 rounded text-sm bg-bg-tertiary text-text-primary border border-border focus:outline-none focus:border-accent-primary"
                autoFocus
              />
              <button
                onClick={handleSaveEdit}
                className="px-2 py-1 rounded text-sm bg-green-600 hover:bg-green-700 text-white"
              >
                保存
              </button>
              <button
                onClick={() => {
                  setEditingGroupId(null)
                  setEditingGroupName('')
                }}
                className="px-2 py-1 rounded text-sm bg-red-600 hover:bg-red-700 text-white"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleSelectGroup(group.id)}
              onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
              className={`px-3 py-1 rounded text-sm whitespace-nowrap ${
                activeGroupId === group.id
                  ? 'bg-bg-secondary text-text-primary'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-secondary'
              }`}
              style={{ borderLeft: `4px solid ${group.color}` }}
            >
              {group.name} ({group.sampleIds.length})
            </button>
          )}
        </div>
      ))}

      {isCreatingGroup ? (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateGroup()
              if (e.key === 'Escape') {
                setIsCreatingGroup(false)
                setNewGroupName('')
              }
            }}
            placeholder="分组名称"
            className="px-3 py-1 rounded text-sm bg-bg-tertiary text-text-primary border border-border focus:outline-none focus:border-accent-primary"
            autoFocus
          />
          <button
            onClick={handleCreateGroup}
            className="px-2 py-1 rounded text-sm bg-accent-primary hover:bg-accent-light text-white"
          >
            创建
          </button>
          <button
            onClick={() => {
              setIsCreatingGroup(false)
              setNewGroupName('')
            }}
            className="px-2 py-1 rounded text-sm bg-red-600 hover:bg-red-700 text-white"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          onClick={() => setIsCreatingGroup(true)}
          className="px-3 py-1 rounded text-sm bg-bg-tertiary text-text-secondary hover:bg-bg-secondary"
        >
          + 新建分组
        </button>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-elevated border border-border rounded-md shadow-lg min-w-[160px] py-1"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-text-primary"
            onClick={() => handleEditFromContextMenu(contextMenu.groupId)}
          >
            重命名
          </button>
          <button
            className="w-full text-left px-4 py-2 text-sm hover:bg-bg-hover text-red-400"
            onClick={() => handleDeleteFromContextMenu(contextMenu.groupId)}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}
