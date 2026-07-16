import { describe, expect, it } from 'vitest'
import { SearchWorkerIndex } from './searchWorkerCore'

describe('SearchWorkerIndex', () => {
  it('preserves search ranking and returns all folder ancestors in one pass', () => {
    const index = new SearchWorkerIndex()
    index.reset([
      { id: 'exact', fileName: 'he', fileExt: '.wav', folderId: 'child', groupIds: ['voice'], importedAt: 2 },
      { id: 'suffix', fileName: 'he1', fileExt: '.wav', folderId: 'child', groupIds: ['voice'], importedAt: 1 },
      { id: 'extended', fileName: 'heng', fileExt: '.wav', folderId: null, groupIds: [], importedAt: 0 },
    ], [['child', 'root'], ['root', null]])

    expect(index.search('he', false, 'voice')).toEqual({
      ids: ['exact', 'suffix'],
      ancestorFolderIds: ['child', 'root'],
    })
  })

  it('applies incremental updates without retaining removed documents', () => {
    const index = new SearchWorkerIndex()
    index.reset([
      { id: 'old', fileName: 'kick', fileExt: '.wav', folderId: null, groupIds: [], importedAt: 1 },
    ], [])
    index.remove(['old'])
    index.upsert([
      { id: 'new', fileName: 'kick new', fileExt: '.wav', folderId: null, groupIds: [], importedAt: 2 },
    ])

    expect(index.search('kick', false, null).ids).toEqual(['new'])
  })
})
