import {
  buildSampleSearchIndex,
  matchSampleSearch,
  parseSearchQuery,
  type SampleSearchIndex,
} from '@/utils/sampleSearch'

export interface WorkerSearchDocument {
  id: string
  fileName: string
  fileExt: string
  folderId: string | null
  groupIds: string[]
  importedAt: number
}

export interface WorkerSearchResult {
  ids: string[]
  ancestorFolderIds: string[]
}

export class SearchWorkerIndex {
  private readonly documents = new Map<string, WorkerSearchDocument>()
  private readonly indexes = new Map<string, SampleSearchIndex>()
  private folderParents = new Map<string, string | null>()

  reset(documents: WorkerSearchDocument[], folderParents: Array<[string, string | null]>): void {
    this.documents.clear()
    this.indexes.clear()
    this.folderParents = new Map(folderParents)
    this.upsert(documents)
  }

  upsert(documents: WorkerSearchDocument[]): void {
    for (const document of documents) {
      this.documents.set(document.id, document)
      this.indexes.set(document.id, buildSampleSearchIndex(document))
    }
  }

  remove(ids: string[]): void {
    ids.forEach((id) => {
      this.documents.delete(id)
      this.indexes.delete(id)
    })
  }

  setFolderParents(folderParents: Array<[string, string | null]>): void {
    this.folderParents = new Map(folderParents)
  }

  search(
    query: string,
    enableChinesePinyinFuzzySearch: boolean,
    activeGroupId: string | null,
  ): WorkerSearchResult {
    const keywords = parseSearchQuery(query)
    const matches = [...this.documents.values()].flatMap((document) => {
      if (activeGroupId && !document.groupIds.includes(activeGroupId)) return []
      const index = this.indexes.get(document.id)
      if (!index) return []
      const match = matchSampleSearch(index, keywords, { enableChinesePinyinFuzzySearch })
      return match ? [{ document, match }] : []
    })
    matches.sort((left, right) => {
      if (right.match.score !== left.match.score) return right.match.score - left.match.score
      if (left.match.earliestPosition !== right.match.earliestPosition) {
        return left.match.earliestPosition - right.match.earliestPosition
      }
      const byName = left.document.fileName.localeCompare(
        right.document.fileName,
        undefined,
        { sensitivity: 'base' },
      )
      return byName || left.document.importedAt - right.document.importedAt
    })

    const ancestorFolderIds = new Set<string>()
    for (const { document } of matches) {
      let folderId = document.folderId
      while (folderId) {
        ancestorFolderIds.add(folderId)
        folderId = this.folderParents.get(folderId) ?? null
      }
    }
    return {
      ids: matches.map(({ document }) => document.id),
      ancestorFolderIds: [...ancestorFolderIds],
    }
  }
}
