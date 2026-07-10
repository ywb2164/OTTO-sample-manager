import { describe, expect, it } from 'vitest'
import type { ImportCandidate, Sample, SampleFolder, SampleGroup } from '@/types'
import { commitLibraryImport, reconcileLibraryState } from './libraryImport'

function createSample(
  id: string,
  filePath: string,
  options: { folderId?: string | null; groupIds?: string[] } = {},
): Sample {
  return {
    id,
    fileName: filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.wav$/i, '') ?? id,
    fileExt: '.wav',
    filePath,
    folderId: options.folderId ?? null,
    originalId: id,
    isCopy: false,
    copyIndex: 0,
    duration: 0,
    sampleRate: 0,
    channels: 0,
    fileSize: 100,
    groupIds: options.groupIds ?? [],
    importedAt: 1,
    isDecoded: false,
    isFileValid: true,
  }
}

function createCandidate(id: string, filePath: string, folderId: string | null = null): ImportCandidate {
  const { groupIds: _groupIds, ...candidate } = createSample(id, filePath, { folderId })
  return candidate
}

function createGroup(id: string, sampleIds: string[] = []): SampleGroup {
  return { id, name: id, color: '#2563eb', sampleIds }
}

function createFolder(
  id: string,
  path: string,
  options: Partial<SampleFolder> = {},
): SampleFolder {
  return {
    id,
    name: path.replace(/\\/g, '/').split('/').pop() ?? path,
    path,
    sampleIds: [],
    childFolderIds: [],
    parentId: null,
    rootId: id,
    depth: 0,
    importedAt: 1,
    isExpanded: false,
    order: 0,
    isRenaming: false,
    ...options,
  }
}

function emptyLibrary() {
  return {
    samples: new Map<string, Sample>(),
    groups: new Map<string, SampleGroup>(),
    folders: new Map<string, SampleFolder>(),
    folderOrder: [] as string[],
  }
}

describe('commitLibraryImport', () => {
  it('adds a new sample to both sides of the selected group relation', () => {
    const library = emptyLibrary()
    library.groups.set('group-a', createGroup('group-a'))

    const result = commitLibraryImport(library, {
      candidates: [createCandidate('new-1', 'D:\\audio\\new.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: 'group-a',
      scannedFileCount: 1,
      failures: [],
    })

    expect(result.summary).toMatchObject({ added: 1, linkedToGroup: 0, skipped: 0, failed: 0 })
    expect(result.state.samples.get('new-1')?.groupIds).toEqual(['group-a'])
    expect(result.state.groups.get('group-a')?.sampleIds).toEqual(['new-1'])
  })

  it('reuses an existing sample and links it to the selected group without duplicating it', () => {
    const library = emptyLibrary()
    library.samples.set('existing', createSample('existing', 'D:\\audio\\same.wav'))
    library.groups.set('group-a', createGroup('group-a'))

    const result = commitLibraryImport(library, {
      candidates: [createCandidate('temporary', 'D:\\audio\\same.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: 'group-a',
      scannedFileCount: 1,
      failures: [],
    })

    expect(result.summary).toMatchObject({ added: 0, linkedToGroup: 1, skipped: 0 })
    expect(result.state.samples.size).toBe(1)
    expect(result.state.samples.get('existing')?.groupIds).toEqual(['group-a'])
    expect(result.state.groups.get('group-a')?.sampleIds).toEqual(['existing'])
  })

  it('links 460 reused samples while skipping the 11 already in the target group', () => {
    const library = emptyLibrary()
    const candidates: ImportCandidate[] = []
    const alreadyLinkedIds: string[] = []

    for (let index = 0; index < 471; index += 1) {
      const id = `sample-${index}`
      const filePath = `D:\\audio\\${index}.wav`
      const isLinked = index < 11
      library.samples.set(id, createSample(id, filePath, { groupIds: isLinked ? ['group-a'] : [] }))
      candidates.push(createCandidate(`temporary-${index}`, filePath))
      if (isLinked) alreadyLinkedIds.push(id)
    }
    library.groups.set('group-a', createGroup('group-a', alreadyLinkedIds))

    const result = commitLibraryImport(library, {
      candidates,
      folders: [],
      rootFolderIds: [],
      targetGroupId: 'group-a',
      scannedFileCount: 471,
      failures: [],
    })

    expect(result.summary).toMatchObject({ added: 0, linkedToGroup: 460, skipped: 11 })
    expect(result.state.samples.size).toBe(471)
    expect(result.state.groups.get('group-a')?.sampleIds).toHaveLength(471)
  })

  it('merges a repeated folder import without replacing stable sample ids or user folder state', () => {
    const library = emptyLibrary()
    const root = createFolder('folder_D:/pack', 'D:/pack', {
      name: '我的音源',
      childFolderIds: ['folder_D:/pack/A'],
      isExpanded: true,
      importedAt: 10,
    })
    const child = createFolder('folder_D:/pack/A', 'D:/pack/A', {
      parentId: root.id,
      rootId: root.id,
      depth: 1,
      sampleIds: ['stable'],
    })
    library.folders.set(root.id, root)
    library.folders.set(child.id, child)
    library.folderOrder.push(root.id)
    library.samples.set('stable', createSample('stable', 'D:\\pack\\A\\a.wav', { folderId: child.id }))

    const rescannedRoot = createFolder(root.id, root.path, {
      name: 'pack',
      childFolderIds: [child.id],
      importedAt: 99,
    })
    const rescannedChild = createFolder(child.id, child.path, {
      parentId: root.id,
      rootId: root.id,
      depth: 1,
      sampleIds: ['temporary'],
      importedAt: 99,
    })

    const result = commitLibraryImport(library, {
      candidates: [createCandidate('temporary', 'D:\\pack\\A\\a.wav', child.id)],
      folders: [rescannedRoot, rescannedChild],
      rootFolderIds: [root.id],
      targetGroupId: null,
      scannedFileCount: 1,
      failures: [],
    })

    expect(result.summary).toMatchObject({ added: 0, skipped: 1 })
    expect(result.state.samples.has('stable')).toBe(true)
    expect(result.state.samples.has('temporary')).toBe(false)
    expect(result.state.folders.get(root.id)).toMatchObject({ name: '我的音源', isExpanded: true, importedAt: 10 })
    expect(result.state.folders.get(child.id)?.sampleIds).toEqual(['stable'])
    expect(result.state.folderOrder).toEqual([root.id])
  })

  it('reports a missing target group and imports the new sample without a dangling group id', () => {
    const result = commitLibraryImport(emptyLibrary(), {
      candidates: [createCandidate('new-1', 'D:\\audio\\new.wav')],
      folders: [],
      rootFolderIds: [],
      targetGroupId: 'missing-group',
      scannedFileCount: 1,
      failures: [],
    })

    expect(result.summary.targetGroupId).toBeNull()
    expect(result.summary.failed).toBe(1)
    expect(result.summary.failures[0]).toMatchObject({ stage: 'commit', path: 'missing-group' })
    expect(result.state.samples.get('new-1')?.groupIds).toEqual([])
  })
})

describe('reconcileLibraryState', () => {
  it('repairs group relations and folder references without losing samples', () => {
    const library = emptyLibrary()
    library.groups.set('group-a', createGroup('group-a', ['group-only', 'missing-sample']))
    library.groups.set('group-b', createGroup('group-b'))
    library.samples.set('sample-only', createSample('sample-only', 'D:\\pack\\sample-only.wav', {
      folderId: 'missing-folder',
      groupIds: ['group-b', 'missing-group'],
    }))
    library.samples.set('group-only', createSample('group-only', 'D:\\pack\\group-only.wav'))

    const first = reconcileLibraryState(library)
    const second = reconcileLibraryState(first)

    expect(first.samples.size).toBe(2)
    expect(first.samples.get('sample-only')?.groupIds).toEqual(['group-b'])
    expect(first.samples.get('group-only')?.groupIds).toEqual(['group-a'])
    expect(first.groups.get('group-a')?.sampleIds).toEqual(['group-only'])
    expect(first.groups.get('group-b')?.sampleIds).toEqual(['sample-only'])
    const repairedFolderId = first.samples.get('sample-only')?.folderId
    expect(repairedFolderId).toBe('folder_D:/pack')
    expect(first.folders.get(repairedFolderId ?? '')?.sampleIds).toEqual(expect.arrayContaining(['sample-only', 'group-only']))
    expect(second).toEqual(first)
  })
})
