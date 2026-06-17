import { beforeEach, describe, expect, it } from 'vitest'
import type { SampleGroup } from '@/types'
import { useSampleStore } from './sampleStore'

function createGroup(id: string): SampleGroup {
  return {
    id,
    name: id,
    color: '#2563eb',
    sampleIds: [],
  }
}

function resetStore() {
  useSampleStore.setState({
    samples: new Map(),
    groups: new Map(),
    groupOrder: [],
    activeGroupId: null,
    selectedIds: new Set(),
    anchorId: null,
    isImporting: false,
    decodeProgress: null,
    folders: new Map(),
    folderOrder: [],
    expandedFolderIds: new Set(),
    preSearchExpandedFolderIds: null,
    hiddenSampleIds: new Set(),
    hiddenFolderIds: new Set(),
    contextMenuTarget: null,
    showSelectionBar: false,
    searchQuery: '',
    lastGroupChangeTimestamp: Date.now(),
  })
}

describe('sample store group order', () => {
  beforeEach(() => {
    resetStore()
  })

  it('appends newly created groups to groupOrder', () => {
    const store = useSampleStore.getState()

    store.addGroup(createGroup('a'))
    store.addGroup(createGroup('b'))

    expect(useSampleStore.getState().groupOrder).toEqual(['a', 'b'])
  })

  it('removes deleted groups from groupOrder', () => {
    const store = useSampleStore.getState()

    store.addGroup(createGroup('a'))
    store.addGroup(createGroup('b'))
    store.removeGroup('a')

    expect(useSampleStore.getState().groupOrder).toEqual(['b'])
  })

  it('moves a group before the target group', () => {
    const store = useSampleStore.getState()

    store.addGroup(createGroup('a'))
    store.addGroup(createGroup('b'))
    store.addGroup(createGroup('c'))
    useSampleStore.getState().moveGroup('a', 'c')

    expect(useSampleStore.getState().groupOrder).toEqual(['b', 'a', 'c'])
  })

  it('derives missing groupOrder from current group insertion order', () => {
    const groups = new Map([
      ['a', createGroup('a')],
      ['b', createGroup('b')],
    ])

    useSampleStore.getState().restoreGroupOrder(null, groups)

    expect(useSampleStore.getState().groupOrder).toEqual(['a', 'b'])
  })
})
