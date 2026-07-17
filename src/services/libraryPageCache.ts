export interface LibraryPageCacheOptions {
  pageSize: number
  maxPages: number
}

interface CachedPage<T> {
  items: T[]
  lastUsed: number
}

export class LibraryPageCache<T extends { id: string }> {
  private readonly pageSize: number
  private maxPages: number
  private generation = 0
  private accessCounter = 0
  private readonly pages = new Map<number, CachedPage<T>>()
  private readonly itemPages = new Map<string, number>()
  private pinnedIds = new Set<string>()
  private requiredPageIndexes = new Set<number>()

  constructor({ pageSize, maxPages }: LibraryPageCacheOptions) {
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new Error('pageSize must be a positive integer')
    }
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new Error('maxPages must be a positive integer')
    }

    this.pageSize = pageSize
    this.maxPages = maxPages
  }

  get loadedPageCount(): number {
    return this.pages.size
  }

  get loadedItemCount(): number {
    return this.itemPages.size
  }

  items(): T[] {
    return [...this.pages.values()].flatMap((page) => page.items)
  }

  reset(): number {
    this.generation += 1
    this.pages.clear()
    this.itemPages.clear()
    this.accessCounter = 0
    return this.generation
  }

  currentGeneration(): number {
    return this.generation
  }

  hasPage(pageIndex: number): boolean {
    const page = this.pages.get(pageIndex)
    if (!page) return false

    page.lastUsed = ++this.accessCounter
    return true
  }

  get(id: string): T | undefined {
    const pageIndex = this.itemPages.get(id)
    if (pageIndex === undefined) return undefined

    const page = this.pages.get(pageIndex)
    if (!page) return undefined

    page.lastUsed = ++this.accessCounter
    return page.items.find((item) => item.id === id)
  }

  storePage(pageIndex: number, items: T[], generation: number): boolean {
    if (generation !== this.generation) return false
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      throw new Error('pageIndex must be a non-negative integer')
    }
    if (items.length > this.pageSize) {
      throw new Error(`page contains ${items.length} items, exceeding pageSize ${this.pageSize}`)
    }

    this.removePage(pageIndex)
    this.pages.set(pageIndex, {
      items: [...items],
      lastUsed: ++this.accessCounter,
    })
    for (const item of items) this.itemPages.set(item.id, pageIndex)

    this.evictToBudget()
    return this.pages.has(pageIndex)
  }

  setPinnedIds(ids: ReadonlySet<string>): void {
    this.pinnedIds = new Set(ids)
    this.evictToBudget()
  }

  setRequiredPageIndexes(pageIndexes: ReadonlySet<number>): void {
    for (const pageIndex of pageIndexes) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw new Error('required page indexes must be non-negative integers')
      }
    }

    this.requiredPageIndexes = new Set(pageIndexes)
    this.evictToBudget()
  }

  setMaxPages(maxPages: number): void {
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new Error('maxPages must be a positive integer')
    }

    this.maxPages = maxPages
    this.evictToBudget()
  }

  private evictToBudget(): void {
    const pageLimit = Math.max(this.maxPages, this.requiredPageIndexes.size)
    while (this.pages.size > pageLimit) {
      let candidateIndex: number | undefined
      let oldestAccess = Number.POSITIVE_INFINITY

      for (const [pageIndex, page] of this.pages) {
        if (this.requiredPageIndexes.has(pageIndex)) continue
        const isPinned = page.items.some((item) => this.pinnedIds.has(item.id))
        if (!isPinned && page.lastUsed < oldestAccess) {
          candidateIndex = pageIndex
          oldestAccess = page.lastUsed
        }
      }

      if (candidateIndex === undefined) {
        candidateIndex = [...this.pages.entries()]
          .filter(([pageIndex]) => !this.requiredPageIndexes.has(pageIndex))
          .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0]?.[0]
      }
      if (candidateIndex === undefined) return
      this.removePage(candidateIndex)
    }
  }

  private removePage(pageIndex: number): void {
    const page = this.pages.get(pageIndex)
    if (!page) return

    this.pages.delete(pageIndex)
    for (const item of page.items) {
      if (this.itemPages.get(item.id) === pageIndex) {
        this.itemPages.delete(item.id)
      }
    }
  }
}
