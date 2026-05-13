import React from 'react'
import { Search, X } from 'lucide-react'
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
    <div className="border-b border-white/5 bg-zinc-950 px-3 py-2">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-white/5 bg-white/[0.035] px-3 text-zinc-500 transition-colors focus-within:border-blue-500/35 focus-within:bg-white/[0.055]">
        <Search size={15} className="flex-shrink-0" />
        <input
          type="text"
          placeholder="搜索音频文件..."
          value={searchQuery}
          onChange={handleChange}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        {searchQuery && (
          <button
            onClick={handleClear}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
            aria-label="清除搜索"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
