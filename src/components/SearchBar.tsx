import React from 'react'
import { useSampleStore } from '@/store/sampleStore'

export const SearchBar: React.FC = () => {
  const searchQuery = useSampleStore((state) => state.searchQuery)
  const setSearchQuery = useSampleStore((state) => state.setSearchQuery)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }

  const handleClear = () => {
    setSearchQuery('')
  }

  return (
    <div className="p-2 border-b border-border-primary flex items-center gap-2">
      <input
        type="text"
        placeholder="搜索音频文件..."
        value={searchQuery}
        onChange={handleChange}
        className="flex-1 bg-bg-secondary text-text-primary p-1 rounded"
      />
      {searchQuery && (
        <button
          onClick={handleClear}
          className="px-2 py-1 bg-bg-tertiary text-text-secondary rounded hover:bg-bg-secondary"
          aria-label="清除搜索"
        >
          ×
        </button>
      )}
    </div>
  )
}
