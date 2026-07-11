import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportCandidate, Sample, SampleGroup } from '@/types'
import { useSampleStore } from './sampleStore'
import { audioRuntimeCache } from '@/services/audioRuntimeCache'

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
    libraryRevision: 0,
    lastImportUndo: null,
    lastUndoSummary: null,
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

  it('binds an import receipt to a revision and undoes exactly once', () => {
    useSampleStore.setState({ groups: new Map([['group-a', createGroup('group-a')]]) })

    useSampleStore.getState().commitImport({
      candidates: [createCandidate('new-1', 'D:\\audio\\new.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: 'group-a',
      scannedFileCount: 1,
      failures: [],
    })

    const imported = useSampleStore.getState()
    expect(imported.libraryRevision).toBe(1)
    expect(imported.lastImportUndo?.expectedLibraryRevision).toBe(1)

    expect(imported.undoLastImport()).toEqual({
      removedSamples: 1,
      removedGroupLinks: 0,
      restoredFolders: 0,
    })
    expect(useSampleStore.getState().samples.size).toBe(0)
    expect(useSampleStore.getState().lastImportUndo).toBeNull()
    expect(useSampleStore.getState().undoLastImport()).toBeNull()
  })

  it('keeps a valid receipt after a fully skipped import but invalidates it on semantic edits', () => {
    const first = useSampleStore.getState().commitImport({
      candidates: [createCandidate('new-1', 'D:\\audio\\new.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: null,
      scannedFileCount: 1,
      failures: [],
    })
    expect(first.added).toBe(1)
    const receipt = useSampleStore.getState().lastImportUndo

    useSampleStore.getState().commitImport({
      candidates: [createCandidate('temporary', 'D:\\audio\\new.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: null,
      scannedFileCount: 1,
      failures: [],
    })
    expect(useSampleStore.getState().lastImportUndo).toEqual(receipt)

    useSampleStore.getState().addGroup(createGroup('group-a'))
    expect(useSampleStore.getState().lastImportUndo).toBeNull()
    expect(useSampleStore.getState().libraryRevision).toBe(2)
  })

  it('does not invalidate undo for decode-only sample metadata updates', () => {
    useSampleStore.getState().commitImport({
      candidates: [createCandidate('new-1', 'D:\\audio\\new.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: null,
      scannedFileCount: 1,
      failures: [],
    })
    const receipt = useSampleStore.getState().lastImportUndo

    useSampleStore.getState().updateSample('new-1', {
      duration: 2,
      sampleRate: 44100,
      channels: 2,
      isDecoded: true,
      isFileValid: true,
    })

    expect(useSampleStore.getState().lastImportUndo).toEqual(receipt)
    expect(useSampleStore.getState().libraryRevision).toBe(1)
  })

  it('applies memory optimization cache budgets through the persisted setting action', () => {
    useSampleStore.getState().setMemoryOptimizationMode(true)
    expect(audioRuntimeCache.getStats()).toMatchObject({
      audioBuffer: { maxBytes: 64 * 1024 * 1024 },
      waveform: { maxBytes: 8 * 1024 * 1024 },
    })

    useSampleStore.getState().setMemoryOptimizationMode(false)
  })
})
