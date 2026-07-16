/// <reference lib="webworker" />

import { SearchWorkerIndex, type WorkerSearchDocument } from './searchWorkerCore'

type SearchWorkerMessage =
  | { type: 'reset'; documents: WorkerSearchDocument[]; folderParents: Array<[string, string | null]> }
  | { type: 'upsert'; documents: WorkerSearchDocument[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'folders'; folderParents: Array<[string, string | null]> }
  | {
      type: 'search'
      requestId: number
      query: string
      enableChinesePinyinFuzzySearch: boolean
      activeGroupId: string | null
    }

const index = new SearchWorkerIndex()

self.onmessage = (event: MessageEvent<SearchWorkerMessage>) => {
  const message = event.data
  if (message.type === 'reset') {
    index.reset(message.documents, message.folderParents)
    return
  }
  if (message.type === 'upsert') {
    index.upsert(message.documents)
    return
  }
  if (message.type === 'remove') {
    index.remove(message.ids)
    return
  }
  if (message.type === 'folders') {
    index.setFolderParents(message.folderParents)
    return
  }
  const result = index.search(
    message.query,
    message.enableChinesePinyinFuzzySearch,
    message.activeGroupId,
  )
  self.postMessage({
    type: 'result',
    requestId: message.requestId,
    ...result,
  })
}

export {}
