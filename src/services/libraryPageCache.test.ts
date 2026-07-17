import { describe, expect, it } from 'vitest'

import { LibraryPageCache } from './libraryPageCache'

type Row = { id: string; value: number }

const page = (pageIndex: number, pageSize = 2): Row[] => Array.from(
  { length: pageSize },
  (_, offset) => ({ id: `${pageIndex}:${offset}`, value: pageIndex * pageSize + offset }),
)

describe('LibraryPageCache', () => {
  it('evicts the least recently used unpinned page at a fixed page limit', () => {
    const cache = new LibraryPageCache<Row>({ pageSize: 2, maxPages: 2 })
    const generation = cache.reset()
    cache.storePage(0, page(0), generation)
    cache.storePage(1, page(1), generation)
    expect(cache.get('0:0')).toEqual({ id: '0:0', value: 0 })

    cache.storePage(2, page(2), generation)

    expect(cache.hasPage(0)).toBe(true)
    expect(cache.hasPage(1)).toBe(false)
    expect(cache.hasPage(2)).toBe(true)
    expect(cache.loadedItemCount).toBe(4)
  })

  it('keeps pages containing pinned ids until those ids are unpinned', () => {
    const cache = new LibraryPageCache<Row>({ pageSize: 2, maxPages: 1 })
    const generation = cache.reset()
    cache.storePage(0, page(0), generation)
    cache.setPinnedIds(new Set(['0:1']))

    cache.storePage(1, page(1), generation)
    expect(cache.hasPage(0)).toBe(true)
    expect(cache.hasPage(1)).toBe(false)

    cache.setPinnedIds(new Set())
    cache.storePage(1, page(1), generation)
    expect(cache.hasPage(0)).toBe(false)
    expect(cache.hasPage(1)).toBe(true)
  })

  it('never exceeds the hard page limit when every page contains a pinned id', () => {
    const cache = new LibraryPageCache<Row>({ pageSize: 1, maxPages: 1 })
    const generation = cache.reset()
    cache.setPinnedIds(new Set(['0:0', '1:0']))

    cache.storePage(0, page(0, 1), generation)
    cache.storePage(1, page(1, 1), generation)

    expect(cache.loadedPageCount).toBe(1)
    expect(cache.loadedItemCount).toBe(1)
  })

  it('keeps every required viewport page resident beyond the background page budget', () => {
    const cache = new LibraryPageCache<Row>({ pageSize: 2, maxPages: 2 })
    const generation = cache.reset()
    cache.setRequiredPageIndexes(new Set([1, 3, 5]))

    for (const pageIndex of [0, 1, 2, 3, 5]) {
      cache.storePage(pageIndex, page(pageIndex), generation)
    }

    expect([1, 3, 5].map((pageIndex) => cache.hasPage(pageIndex))).toEqual([true, true, true])
    expect(cache.loadedPageCount).toBe(3)
    expect(cache.hasPage(0)).toBe(false)
    expect(cache.hasPage(2)).toBe(false)

    cache.storePage(4, page(4), generation)

    expect([1, 3, 5].map((pageIndex) => cache.hasPage(pageIndex))).toEqual([true, true, true])
    expect(cache.loadedPageCount).toBe(3)
    expect(cache.hasPage(4)).toBe(false)
  })

  it('rejects stale page responses after a query generation reset', () => {
    const cache = new LibraryPageCache<Row>({ pageSize: 2, maxPages: 2 })
    const staleGeneration = cache.reset()
    const currentGeneration = cache.reset()

    expect(cache.storePage(0, page(0), staleGeneration)).toBe(false)
    expect(cache.storePage(0, page(0), currentGeneration)).toBe(true)
    expect(cache.loadedItemCount).toBe(2)
  })

  it('switches between the default eight-page and low-memory three-page budgets', () => {
    const cache = new LibraryPageCache<Row>({ pageSize: 2, maxPages: 8 })
    const generation = cache.reset()
    for (let index = 0; index < 8; index += 1) cache.storePage(index, page(index), generation)
    expect(cache.loadedPageCount).toBe(8)

    cache.setMaxPages(3)

    expect(cache.loadedPageCount).toBe(3)
    expect(cache.loadedItemCount).toBe(6)
  })
})
