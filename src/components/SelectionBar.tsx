import React, { useState } from 'react'
import { ChevronDown, Layers3, Trash2, X } from 'lucide-react'
import { useSampleStore } from '@/store/sampleStore'

export const SelectionBar: React.FC = () => {
  const { selectedIds, clearSelection, removeSamples, groups, addToGroup, removeFromGroup, samples } = useSampleStore()
  const [showGroupDropdown, setShowGroupDropdown] = useState(false)
  const groupList = Array.from(groups.values())

  const handleClear = () => {
    clearSelection()
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return

    const confirmed = window.confirm(`确定删除选中的 ${selectedIds.size} 个样本吗？文件不会从本地移除`)
    if (confirmed) {
      removeSamples([...selectedIds])
      clearSelection()
    }
  }

  const handleGroupAction = (groupId: string) => {
    const selectedArray = [...selectedIds]
    // 检查选中的样本是否都已经在该分组中
    const allInGroup = selectedArray.every(id => {
      const sample = samples.get(id)
      return sample?.groupIds.includes(groupId)
    })

    if (allInGroup) {
      // 全部已在分组中，则从分组移除
      removeFromGroup(selectedArray, groupId)
    } else {
      // 否则添加到分组
      addToGroup(selectedArray, groupId)
    }
    setShowGroupDropdown(false)
  }

  if (selectedIds.size === 0) return null

  return (
    <div className="pointer-events-none absolute left-2 right-2 top-2 z-20 flex justify-center">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-zinc-950/95 px-1.5 py-1.5 text-xs text-zinc-100 shadow-lg shadow-black/30 backdrop-blur-xl">
        <span className="shrink-0 px-1.5 text-zinc-500">已选 {selectedIds.size}</span>
        <button
          onClick={handleClear}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/5 bg-transparent px-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <X size={13} />
          <span>返回</span>
        </button>
        <button
          onClick={handleDeleteSelected}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-red-500/10 px-2 text-red-300 transition-colors hover:bg-red-500/20"
        >
          <Trash2 size={13} />
          <span>移除</span>
        </button>

        <div className="relative">
          <button
            onClick={() => setShowGroupDropdown(prev => !prev)}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2 text-white transition-colors hover:bg-blue-500"
          >
            <Layers3 size={13} />
            <span>分组</span>
            <ChevronDown size={13} />
          </button>
          {showGroupDropdown && (
            <div className="absolute left-0 top-full z-[100] mt-2 max-h-60 min-w-[180px] overflow-y-auto rounded-lg border border-white/5 bg-zinc-950/95 py-1.5 shadow-lg shadow-black/30 backdrop-blur-xl">
              {groupList.length === 0 ? (
                <div className="px-3 py-2 text-xs text-text-dim">暂无分组</div>
              ) : (
                groupList.map(group => (
                  <button
                    key={group.id}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover"
                    onClick={() => handleGroupAction(group.id)}
                  >
                    <span className="h-2.5 w-2.5 rounded-full border border-white/20" style={{ backgroundColor: group.color }} />
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        </div>
    </div>
  )
}
