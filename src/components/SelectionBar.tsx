import React, { useState } from 'react'
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

    const confirmed = window.confirm(`确定删除选中的 ${selectedIds.size} 个样本吗？`)
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
    <div className="p-2 bg-blue-900 text-white flex justify-between items-center text-sm">
      <div className="flex items-center gap-4">
        <span>已选中 {selectedIds.size} 个样本</span>
        <button
          onClick={handleClear}
          className="px-3 py-1 bg-blue-700 rounded hover:bg-blue-600 transition-colors"
        >
          返回
        </button>
        <button
          onClick={handleDeleteSelected}
          className="px-3 py-1 bg-red-700 rounded hover:bg-red-600 transition-colors"
        >
          移除采样
        </button>

        {/* 分配到分组下拉菜单 */}
        <div className="relative">
          <button
            onClick={() => setShowGroupDropdown(prev => !prev)}
            className="px-3 py-1 bg-green-700 rounded hover:bg-green-600 transition-colors"
          >
            分配到分组 ▾
          </button>
          {showGroupDropdown && (
            <div className="absolute top-full left-0 mt-1 bg-blue-800 border border-blue-600 rounded shadow-lg min-w-[160px] max-h-60 overflow-y-auto z-50">
              {groupList.length === 0 ? (
                <div className="px-3 py-2 text-sm text-blue-200">暂无分组</div>
              ) : (
                groupList.map(group => (
                  <button
                    key={group.id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-blue-700 text-white flex items-center gap-2"
                    onClick={() => handleGroupAction(group.id)}
                  >
                    <span className="w-3 h-3 rounded-full border border-white/30" style={{ backgroundColor: group.color }} />
                    <span>{group.name}</span>
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
