import React, { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { useSampleStore } from '@/store/sampleStore'

export const SearchBar: React.FC = () => {
  const searchQuery = useSampleStore((state) => state.searchQuery)
  const setSearchQuery = useSampleStore((state) => state.setSearchQuery)
  const getOrderedIds = useSampleStore((state) => state.getOrderedIds)
  const setSelected = useSampleStore((state) => state.setSelected)
  const setAnchorId = useSampleStore((state) => state.setAnchorId)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }

  const handleClear = () => {
    setSearchQuery('')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const ensureActiveResult = () => {
      const orderedIds = getOrderedIds()
      if (!orderedIds.length) return null
      const { anchorId, selectedIds } = useSampleStore.getState()
      const current = anchorId && orderedIds.includes(anchorId)
        ? anchorId
        : [...selectedIds].find((id) => orderedIds.includes(id))
      const activeId = current ?? orderedIds[0]
      setSelected(new Set([activeId]))
      setAnchorId(activeId)
      return activeId
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      if (searchQuery) {
        setSearchQuery('')
      } else {
        inputRef.current?.blur()
        window.dispatchEvent(new CustomEvent('otto:focus-list'))
      }
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      if (ensureActiveResult()) {
        window.dispatchEvent(new CustomEvent('otto:preview-active'))
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      ensureActiveResult()
      inputRef.current?.blur()
      window.dispatchEvent(new CustomEvent('otto:focus-list'))
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

    event.preventDefault()
    const orderedIds = getOrderedIds()
    if (!orderedIds.length) return
    const { anchorId, selectedIds } = useSampleStore.getState()
    const activeId = anchorId ?? selectedIds.values().next().value as string | undefined
    const currentIndex = activeId ? orderedIds.indexOf(activeId) : -1
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex = currentIndex === -1
      ? (delta > 0 ? 0 : orderedIds.length - 1)
      : Math.max(0, Math.min(orderedIds.length - 1, currentIndex + delta))
    const nextId = orderedIds[nextIndex]
    setSelected(new Set([nextId]))
    setAnchorId(nextId)
  }

  return (
    <div className="border-b border-white/5 bg-zinc-950 px-3 py-2">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-white/5 bg-white/[0.035] px-3 text-zinc-400 transition-colors focus-within:border-blue-500/35 focus-within:bg-white/[0.055]">
        <Search size={15} className="flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          placeholder="搜索音频文件..."
          value={searchQuery}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-400"
        />
        {searchQuery && (
          <button
            onClick={handleClear}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            aria-label="清除搜索"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
