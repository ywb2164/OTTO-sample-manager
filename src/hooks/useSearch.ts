import { useEffect, useRef } from 'react'
import { getDesktopBridge } from '@/services/desktopBridge'
import { useSampleStore } from '@/store/sampleStore'
import type { Sample } from '@/types'
import type { WorkerSearchDocument } from '@/workers/searchWorkerCore'

type WorkerResult = {
  type: 'result'
  requestId: number
  ids: string[]
  ancestorFolderIds: string[]
}

function toSearchDocument(sample: Sample): WorkerSearchDocument {
  return {
    id: sample.id,
    fileName: sample.fileName,
    fileExt: sample.fileExt,
    folderId: sample.folderId ?? null,
    groupIds: sample.groupIds,
    importedAt: sample.importedAt,
  }
}

function signature(sample: Sample): string {
  return `${sample.fileName}\u0000${sample.fileExt}\u0000${sample.folderId ?? ''}\u0000${sample.groupIds.join('\u0001')}\u0000${sample.importedAt}`
}

export function useSearchWorker(): void {
  const libraryChangeVersion = useSampleStore((state) => state.libraryRevision + state.persistenceVersion)
  const pagedLibrary = useSampleStore((state) => state.pagedLibrary)
  const folders = useSampleStore((state) => state.folders)
  const searchQuery = useSampleStore((state) => state.searchQuery)
  const activeGroupId = useSampleStore((state) => state.activeGroupId)
  const enableChinesePinyinFuzzySearch = useSampleStore(
    (state) => state.folderSettings.enableChinesePinyinFuzzySearch,
  )
  const setSearchResults = useSampleStore((state) => state.setSearchResults)
  const workerRef = useRef<Worker | null>(null)
  const latestRequestIdRef = useRef(0)
  const indexedSignaturesRef = useRef(new Map<string, string>())
  const initializedRef = useRef(false)

  useEffect(() => {
    const worker = new Worker(new URL('../workers/sampleSearch.worker.ts', import.meta.url), {
      type: 'module',
      name: 'otto-sample-search',
    })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.type !== 'result' || event.data.requestId !== latestRequestIdRef.current) return
      setSearchResults(event.data.ids, event.data.ancestorFolderIds)
    }

    const initialize = async () => {
      const desktop = getDesktopBridge()
      const folderParents = [...useSampleStore.getState().folders.values()]
        .map((folder): [string, string | null] => [folder.id, folder.parentId])
      worker.postMessage({ type: 'reset', documents: [], folderParents })

      if (desktop.runtime === 'tauri') {
        for await (const batch of desktop.library.getSearchIndexBatches(1000)) {
          const documents = batch.documents.map((document): WorkerSearchDocument => ({
            id: document.id,
            fileName: document.fileName,
            fileExt: document.extension,
            folderId: document.folderId,
            groupIds: document.groupIds,
            importedAt: document.importedAt,
          }))
          worker.postMessage({ type: 'upsert', documents })
          documents.forEach((document) => {
            const sample = useSampleStore.getState().samples.get(document.id)
            if (sample) indexedSignaturesRef.current.set(document.id, signature(sample))
          })
        }
      } else {
        const currentSamples = useSampleStore.getState().samples
        const documents = [...currentSamples.values()].map(toSearchDocument)
        worker.postMessage({ type: 'upsert', documents })
        currentSamples.forEach((sample) => indexedSignaturesRef.current.set(sample.id, signature(sample)))
      }
      initializedRef.current = true
      const state = useSampleStore.getState()
      if (state.searchQuery.trim()) {
        const requestId = latestRequestIdRef.current + 1
        latestRequestIdRef.current = requestId
        worker.postMessage({
          type: 'search',
          requestId,
          query: state.searchQuery,
          activeGroupId: state.activeGroupId,
          enableChinesePinyinFuzzySearch: state.folderSettings.enableChinesePinyinFuzzySearch,
        })
      }
    }
    void initialize()

    return () => {
      worker.terminate()
      workerRef.current = null
      initializedRef.current = false
      indexedSignaturesRef.current.clear()
    }
  }, [setSearchResults])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker || !initializedRef.current) return undefined
    if (pagedLibrary) {
      let cancelled = false
      const reload = async () => {
        const desktop = getDesktopBridge()
        const folderParents = [...useSampleStore.getState().folders.values()]
          .map((folder): [string, string | null] => [folder.id, folder.parentId])
        worker.postMessage({ type: 'reset', documents: [], folderParents })
        for await (const batch of desktop.library.getSearchIndexBatches(1000)) {
          if (cancelled) return
          worker.postMessage({
            type: 'upsert',
            documents: batch.documents.map((document): WorkerSearchDocument => ({
              id: document.id,
              fileName: document.fileName,
              fileExt: document.extension,
              folderId: document.folderId,
              groupIds: document.groupIds,
              importedAt: document.importedAt,
            })),
          })
        }
        const state = useSampleStore.getState()
        if (cancelled || !state.searchQuery.trim()) return
        const requestId = latestRequestIdRef.current + 1
        latestRequestIdRef.current = requestId
        worker.postMessage({
          type: 'search',
          requestId,
          query: state.searchQuery,
          activeGroupId: state.activeGroupId,
          enableChinesePinyinFuzzySearch: state.folderSettings.enableChinesePinyinFuzzySearch,
        })
      }
      void reload()
      return () => { cancelled = true }
    }
    const samples = useSampleStore.getState().samples
    const nextSignatures = new Map<string, string>()
    const upserts: WorkerSearchDocument[] = []
    samples.forEach((sample) => {
      const nextSignature = signature(sample)
      nextSignatures.set(sample.id, nextSignature)
      if (indexedSignaturesRef.current.get(sample.id) !== nextSignature) {
        upserts.push(toSearchDocument(sample))
      }
    })
    const removed = [...indexedSignaturesRef.current.keys()].filter((id) => !samples.has(id))
    if (upserts.length) worker.postMessage({ type: 'upsert', documents: upserts })
    if (removed.length) worker.postMessage({ type: 'remove', ids: removed })
    indexedSignaturesRef.current = nextSignatures
    return undefined
  }, [libraryChangeVersion, pagedLibrary])

  useEffect(() => {
    workerRef.current?.postMessage({
      type: 'folders',
      folderParents: [...folders.values()].map((folder): [string, string | null] => [folder.id, folder.parentId]),
    })
  }, [folders])

  useEffect(() => {
    if (!searchQuery.trim()) return
    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId
    const timeout = window.setTimeout(() => {
      workerRef.current?.postMessage({
        type: 'search',
        requestId,
        query: searchQuery,
        activeGroupId,
        enableChinesePinyinFuzzySearch,
      })
    }, 80)
    return () => window.clearTimeout(timeout)
  }, [activeGroupId, enableChinesePinyinFuzzySearch, searchQuery])
}
