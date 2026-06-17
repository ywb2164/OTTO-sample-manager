import React from 'react'
import { Trash2, X } from 'lucide-react'
import { useSampleStore } from '@/store/sampleStore'

export const SelectionBar: React.FC = () => {
  const { selectedIds, clearSelection, removeSamples } = useSampleStore()

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

  if (selectedIds.size === 0) return null

  return (
    <div className="pointer-events-none absolute left-2 right-2 top-2 z-20 flex justify-center">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-lg border border-white/5 bg-zinc-950/95 px-1.5 py-1.5 text-xs text-zinc-100 shadow-lg shadow-black/30 backdrop-blur-xl">
        <span className="shrink-0 px-1.5 text-zinc-300">已选 {selectedIds.size}</span>
        <button
          onClick={handleClear}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/5 bg-transparent px-2 text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100"
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

        </div>
    </div>
  )
}
