import { describe, expect, it } from 'vitest'

import type { Sample, SampleFolder, SampleGroup } from '@/types'
import { buildLibraryMutationBatch, snapshotLibrary } from './libraryMutations'

const sample: Sample = {
  id: 'sample-1',
  fileName: 'kick',
  fileExt: '.wav',
  filePath: 'D:\\samples\\kick.wav',
  folderId: 'folder-1',
  originalId: 'sample-1',
  isCopy: false,
  copyIndex: 0,
  duration: 1.25,
  sampleRate: 48000,
  channels: 2,
  fileSize: 1200,
  groupIds: ['group-1'],
  importedAt: 12,
  isDecoded: true,
  isFileValid: true,
}

const folder: SampleFolder = {
  id: 'folder-1',
  name: 'samples',
  path: 'D:/samples',
  sampleIds: ['sample-1'],
  childFolderIds: [],
  parentId: null,
  rootId: 'folder-1',
  depth: 0,
  importedAt: 12,
  isExpanded: false,
  order: 0,
  isRenaming: false,
}

const group: SampleGroup = { id: 'group-1', name: 'Drums', color: '#fff', sampleIds: ['sample-1'] }

function state() {
  return {
    samples: new Map([[sample.id, sample]]),
    folders: new Map([[folder.id, folder]]),
    groups: new Map([[group.id, group]]),
    folderOrder: [folder.id],
    groupOrder: [group.id],
    expandedFolderIds: new Set<string>(),
    folderSettings: { expandOnSearch: true },
  }
}

describe('library mutation batching', () => {
  it('omits runtime-only sample changes and emits only persisted changes', () => {
    const previous = snapshotLibrary(state())
    const runtimeOnly = state()
    runtimeOnly.samples.set(sample.id, { ...sample, waveformData: new Float32Array([0, 1]), isDecoded: false })
    expect(buildLibraryMutationBatch(previous, snapshotLibrary(runtimeOnly))).toBeNull()

    const changed = state()
    changed.samples.set(sample.id, { ...sample, fileName: 'kick-tight', groupIds: [] })
    const batch = buildLibraryMutationBatch(previous, snapshotLibrary(changed))
    expect(batch?.upsertSamples).toEqual([expect.objectContaining({ fileName: 'kick-tight', groupIds: [] })])
    expect(batch?.upsertFolders).toEqual([])
  })

  it('captures deletes, ordering, expansion, and settings without a full-library write', () => {
    const previous = snapshotLibrary(state())
    const changed = state()
    changed.samples.clear()
    changed.expandedFolderIds.add(folder.id)
    changed.groupOrder = []
    changed.folderSettings = { expandOnSearch: false }

    const batch = buildLibraryMutationBatch(previous, snapshotLibrary(changed))
    expect(batch?.deleteSampleIds).toEqual(['sample-1'])
    expect(batch?.upsertFolders).toEqual([expect.objectContaining({ id: 'folder-1', isExpanded: true })])
    expect(batch?.groupOrder).toEqual([])
    expect(batch?.folderSettings).toEqual({ expandOnSearch: false })
  })

  it('can exclude page-cache contents so eviction is never persisted as deletion', () => {
    const previous = snapshotLibrary(state(), { includeSamples: false })
    const evicted = state()
    evicted.samples.clear()

    expect(buildLibraryMutationBatch(previous, snapshotLibrary(evicted, { includeSamples: false }))).toBeNull()
  })
})
