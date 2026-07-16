import { useEffect, useRef } from 'react'

import { useSampleStore } from '@/store/sampleStore'
import { getDesktopBridge } from '@/services/desktopBridge'
import {
  buildLibraryMutationBatch,
  snapshotLibrary,
  type LibraryPersistenceSnapshot,
} from '@/services/libraryMutations'

export function useTauriLibraryPersistence(enabled: boolean): void {
  const changeVersion = useSampleStore((state) => state.libraryRevision + state.persistenceVersion)
  const pagedLibrary = useSampleStore((state) => state.pagedLibrary)
  const persistedRef = useRef<LibraryPersistenceSnapshot | null>(null)
  const writeChainRef = useRef(Promise.resolve())

  useEffect(() => {
    if (!enabled) {
      persistedRef.current = null
      return
    }

    const target = snapshotLibrary(useSampleStore.getState(), { includeSamples: !pagedLibrary })
    if (!persistedRef.current) {
      persistedRef.current = target
      return
    }

    const desktop = getDesktopBridge()
    writeChainRef.current = writeChainRef.current
      .then(async () => {
        const previous = persistedRef.current
        if (!previous) return
        const batch = buildLibraryMutationBatch(previous, target)
        if (!batch) return

        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await desktop.library.applyMutations(batch)
            persistedRef.current = target
            return
          } catch (error) {
            lastError = error
            if (attempt < 2) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, 100 * (2 ** attempt)))
            }
          }
        }
        throw lastError
      })
      .catch((error) => {
        console.error('SQLite 增量保存失败', error)
        window.dispatchEvent(new CustomEvent('otto:persistence-error', {
          detail: error instanceof Error ? error.message : String(error),
        }))
      })
  }, [changeVersion, enabled, pagedLibrary])
}
