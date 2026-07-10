import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportCandidate, Sample, SampleGroup } from '@/types'
import { useSampleStore } from './sampleStore'

function createGroup(id: string): SampleGroup {
  return {
    id,
    name: id,
    color: '#2563eb',
    sampleIds: [],
  }
}

function createSample(id: string, filePath: string): Sample {
  return {
    id,
    fileName: id,
    fileExt: '.wav',
    filePath,
    folderId: null,
    originalId: id,
    isCopy: false,
    copyIndex: 0,
    duration: 0,
    sampleRate: 0,
    channels: 0,
    fileSize: 100,
    groupIds: [],
    importedAt: 1,
    isDecoded: false,
    isFileValid: true,
  }
}

function createCandidate(id: string, filePath: string): ImportCandidate {
  const { groupIds: _groupIds, ...candidate } = createSample(id, filePath)
  return candidate
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

describe('sample store import transaction', () => {
  beforeEach(() => {
    resetStore()
  })

  it('commits duplicate grouping to samples and groups atomically', () => {
    const store = useSampleStore.getState()
    store.addGroup(createGroup('group-a'))
    store.addSamples([createSample('existing', 'D:\\audio\\same.wav')])

    const summary = useSampleStore.getState().commitImport({
      candidates: [createCandidate('temporary', 'D:\\audio\\same.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: 'group-a',
      scannedFileCount: 1,
      failures: [],
    })

    const next = useSampleStore.getState()
    expect(summary).toMatchObject({ added: 0, linkedToGroup: 1, skipped: 0 })
    expect(next.samples.size).toBe(1)
    expect(next.samples.get('existing')?.groupIds).toEqual(['group-a'])
    expect(next.groups.get('group-a')?.sampleIds).toEqual(['existing'])
  })
})
