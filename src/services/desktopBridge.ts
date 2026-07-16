import type { CopySettings, ScannedFolderNode, UpdateState } from '@/types'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface LibraryQuery {
  offset?: number
  limit?: number
  folderId?: string | null
  groupId?: string | null
}

export interface LibrarySampleRecord {
  id: string
  folderId: string | null
  filePath: string
  fileName: string
  extension: string
  originalId: string
  isCopy: boolean
  copyIndex: number
  fileSize: number
  durationMs: number | null
  sampleRate: number | null
  channels: number | null
  isValid: boolean
  importedAt: number
  groupIds: string[]
}

export interface LibraryPage {
  items: LibrarySampleRecord[]
  total: number
  offset: number
  hasMore: boolean
}

export interface SearchDocument {
  id: string
  fileName: string
  extension: string
  folderId: string | null
  groupIds: string[]
  importedAt: number
}

export interface SearchDocumentBatch {
  documents: SearchDocument[]
  nextOffset: number | null
}

export interface LibraryBootstrap {
  folders: Array<{
    id: string
    parentId: string | null
    name: string
    path: string
    rootId: string
    depth: number
    order: number
    isExpanded: boolean
    importedAt: number
  }>
  groups: Array<{ id: string; name: string; color: string; order: number }>
  folderOrder: string[]
  groupOrder: string[]
  settings: Record<string, unknown>
}

export interface LibraryFolderRecord {
  id: string
  parentId: string | null
  name: string
  path: string
  rootId: string
  depth: number
  order: number
  isExpanded: boolean
  importedAt: number
}

export interface LibraryGroupRecord {
  id: string
  name: string
  color: string
  order: number
}

export interface LibraryMutationBatch {
  upsertSamples: LibrarySampleRecord[]
  deleteSampleIds: string[]
  upsertFolders: LibraryFolderRecord[]
  deleteFolderIds: string[]
  upsertGroups: LibraryGroupRecord[]
  deleteGroupIds: string[]
  replaceSampleGroups?: Array<{ sampleId: string; groupIds: string[] }>
  folderOrder?: string[]
  groupOrder?: string[]
  folderSettings?: Record<string, unknown>
}

export interface ImportRequest {
  rootPath?: string | null
  filePaths?: string[]
  targetGroupId?: string | null
}

export interface ImportProgress {
  sessionId: string
  state: 'scanning' | 'committed' | 'cancelled' | 'failed'
  discovered: number
  processed: number
  added: number
  duplicates: number
  linkedToGroup: number
  failed: number
  currentPath: string | null
  message: string | null
}

export interface DragResult {
  cancelled: boolean
  effect: number
  paths: string[]
}

export interface ScanFolderResult {
  root: ScannedFolderNode | null
  scannedFileCount: number
  failures: Array<{ path: string; stage: 'scan'; reason: string }>
}

export interface FileInfoResult {
  path: string
  exists: boolean
  fileSize: number
  reason?: string
}

export interface LyricsFilesPayload {
  targetGroupName: string
  items: Array<{ id: string; sourcePath: string; fileName: string }>
}

export interface LyricsFilesResult {
  success: Array<{ id: string; sourcePath: string; targetPath: string; fileSize: number }>
  failed: Array<{ id: string; sourcePath: string; reason: string }>
  targetDir: string | null
}

export interface DesktopBridge {
  runtime: 'electron' | 'tauri'
  startup: {
    getStatus: () => Promise<{ error: string | null; writable: boolean }>
  }
  window: {
    close: () => void
    minimize: () => void
    getState: () => Promise<{ alwaysOnTop: boolean; opacity: number }>
    getAlwaysOnTop: () => Promise<boolean>
    setAlwaysOnTop: (value: boolean) => void
    getOpacity: () => Promise<number>
    setOpacity: (value: number) => void
    getAppVersion: () => Promise<string>
    onFilesDropped: (listener: (paths: string[]) => void) => () => void
  }
  dialogs: {
    openFiles: () => Promise<string[]>
    openFolder: () => Promise<string | null>
    openLyricsFile: () => Promise<string | null>
  }
  library: {
    scanFolder: (folderPath: string) => Promise<ScanFolderResult>
    getFilesInfo: (filePaths: string[]) => Promise<FileInfoResult[]>
    validateFiles: (filePaths: string[]) => Promise<Array<{ path: string; valid: boolean }>>
    queryPage: (request: LibraryQuery) => Promise<LibraryPage>
    getBootstrap: () => Promise<LibraryBootstrap>
    getSearchIndexBatch: (offset: number, limit?: number) => Promise<SearchDocumentBatch>
    getSearchIndexBatches: (batchSize?: number) => AsyncIterable<SearchDocumentBatch>
    applyMutations: (batch: LibraryMutationBatch) => Promise<void>
    startImport: (request: ImportRequest) => Promise<string>
    cancelImport: (sessionId: string) => Promise<void>
    undoLastImport: () => Promise<{ removedSamples: number; removedGroupLinks: number; removedFolders: number } | null>
    onImportProgress: (listener: (progress: ImportProgress) => void) => () => void
  }
  audio: {
    getStreamUrl: (sampleId: string) => Promise<string>
    readSampleBytes: (sampleId: string, signal?: AbortSignal) => Promise<ArrayBuffer>
    getWaveform: (sampleId: string) => Promise<{ mins: number[]; maxs: number[] }>
  }
  legacyStorage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
  } | null
  copySettings: {
    get: () => Promise<CopySettings>
    set: (settings: CopySettings) => Promise<void>
  }
  files: {
    readAsBuffer: (filePath: string) => Promise<ArrayBuffer>
    createLyricsFiles: (payload: LyricsFilesPayload) => Promise<LyricsFilesResult>
  }
  shell: {
    revealPath: (filePath: string) => void
    openExternal: (url: string) => void
  }
  drag: {
    start: (request: { sampleIds: string[]; filePaths?: string[] }) => Promise<DragResult>
  }
  updater: {
    getState: () => Promise<UpdateState>
    check: (options?: { manual?: boolean }) => Promise<UpdateState>
    start: () => Promise<void>
    onState: (listener: (state: UpdateState) => void) => () => void
  }
}

export function createElectronDesktopBridge(api: Window['electronAPI']): DesktopBridge {
  return {
    runtime: 'electron',
    startup: {
      getStatus: async () => ({ error: null, writable: true }),
    },
    window: {
      close: api.closeWindow,
      minimize: api.minimizeWindow,
      getState: async () => {
        const [alwaysOnTop, opacity] = await Promise.all([api.getAlwaysOnTop(), api.getOpacity()])
        return { alwaysOnTop, opacity }
      },
      getAlwaysOnTop: api.getAlwaysOnTop,
      setAlwaysOnTop: api.setAlwaysOnTop,
      getOpacity: api.getOpacity,
      setOpacity: api.setOpacity,
      getAppVersion: api.getAppVersion,
      onFilesDropped: () => () => undefined,
    },
    dialogs: {
      openFiles: api.openFileDialog,
      openFolder: api.openFolderDialog,
      openLyricsFile: api.openLyricsFileDialog,
    },
    library: {
      scanFolder: api.scanFolder,
      getFilesInfo: api.getFilesInfo,
      validateFiles: api.validateFiles,
      queryPage: async () => ({ items: [], total: 0, offset: 0, hasMore: false }),
      getBootstrap: async () => ({ folders: [], groups: [], folderOrder: [], groupOrder: [], settings: {} }),
      getSearchIndexBatch: async () => ({ documents: [], nextOffset: null }),
      getSearchIndexBatches: async function* () {
        return
      },
      applyMutations: async () => undefined,
      startImport: async () => { throw new Error('Incremental import is only available in the Tauri runtime') },
      cancelImport: async () => undefined,
      undoLastImport: async () => null,
      onImportProgress: () => () => undefined,
    },
    audio: {
      getStreamUrl: async () => { throw new Error('Streaming audio is only available in the Tauri runtime') },
      readSampleBytes: async () => { throw new Error('Sample ID reads are only available in the Tauri runtime') },
      getWaveform: async () => { throw new Error('Rust waveform generation is only available in the Tauri runtime') },
    },
    legacyStorage: {
      get: api.storeGet,
      set: api.storeSet,
      delete: api.storeDelete,
    },
    copySettings: {
      get: async () => {
        const stored = await api.storeGet('copySettings') as Partial<CopySettings> | null
        return {
          enableAutoCopy: stored?.enableAutoCopy ?? true,
          keepCopies: stored?.keepCopies ?? false,
        }
      },
      set: (settings) => api.storeSet('copySettings', settings),
    },
    files: {
      readAsBuffer: api.readFileAsBuffer,
      createLyricsFiles: api.createLyricsFiles,
    },
    shell: {
      revealPath: api.showInExplorer,
      openExternal: api.openExternalLink,
    },
    drag: {
      start: async ({ filePaths = [] }) => {
        api.dragOutFiles(filePaths)
        return { cancelled: false, effect: 1, paths: filePaths }
      },
    },
    updater: {
      getState: api.getUpdateState,
      check: api.checkForUpdates,
      start: api.startUpdate,
      onState: api.onUpdateState,
    },
  }
}

export function createTauriDesktopBridge(): DesktopBridge {
  let pendingUpdate: Update | null = null
  let updateState: UpdateState = {
    phase: 'idle',
    currentVersion: '',
    availableVersion: null,
    progressPercent: null,
    message: null,
    action: 'none',
  }
  const updateListeners = new Set<(state: UpdateState) => void>()
  const publishUpdate = (patch: Partial<UpdateState>) => {
    updateState = { ...updateState, ...patch }
    updateListeners.forEach((listener) => listener(updateState))
  }
  const getCurrentVersion = async () => {
    if (!updateState.currentVersion) {
      updateState = { ...updateState, currentVersion: await invoke<string>('app_version') }
    }
    return updateState.currentVersion
  }

  return {
    runtime: 'tauri',
    startup: {
      getStatus: () => invoke<{ error: string | null; writable: boolean }>('startup_status'),
    },
    window: {
      close: () => { void invoke('window_close') },
      minimize: () => { void invoke('window_minimize') },
      getState: () => invoke('window_get_state'),
      getAlwaysOnTop: async () => (await invoke<{ alwaysOnTop: boolean }>('window_get_state')).alwaysOnTop,
      setAlwaysOnTop: (value) => { void invoke('window_set_always_on_top', { value }) },
      getOpacity: async () => (await invoke<{ opacity: number }>('window_get_state')).opacity,
      setOpacity: (value) => { void invoke('window_set_opacity', { value }) },
      getAppVersion: () => invoke<string>('app_version'),
      onFilesDropped: (listener) => {
        let disposed = false
        const unlisten = getCurrentWindow().onDragDropEvent((event) => {
          if (!disposed && event.payload.type === 'drop') listener(event.payload.paths)
        })
        return () => {
          disposed = true
          void unlisten.then((stop) => stop())
        }
      },
    },
    dialogs: {
      openFiles: async () => {
        const selected = await open({
          title: '导入音频采样',
          multiple: true,
          filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aiff', 'aif', 'm4a'] }],
        })
        return selected ?? []
      },
      openFolder: () => open({ title: '导入整个文件夹', directory: true, recursive: true }),
      openLyricsFile: () => open({
        title: '选择活字印刷文本 txt',
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      }),
    },
    library: {
      scanFolder: async () => { throw new Error('Tauri uses background import sessions') },
      getFilesInfo: (filePaths) => invoke<FileInfoResult[]>('get_files_info', { filePaths }),
      validateFiles: (filePaths) => invoke<Array<{ path: string; valid: boolean }>>('validate_files', { filePaths }),
      queryPage: (request) => invoke<LibraryPage>('library_query_page', {
        request: {
          offset: request.offset ?? 0,
          limit: request.limit ?? 100,
          folderId: request.folderId ?? null,
          groupId: request.groupId ?? null,
        },
      }),
      getBootstrap: () => invoke<LibraryBootstrap>('library_get_bootstrap'),
      getSearchIndexBatch: (offset, limit = 1000) => invoke<SearchDocumentBatch>(
        'library_get_search_index_batch',
        { offset, limit },
      ),
      getSearchIndexBatches: async function* (batchSize = 1000) {
        let offset = 0
        while (true) {
          const batch = await invoke<SearchDocumentBatch>('library_get_search_index_batch', {
            offset,
            limit: batchSize,
          })
          yield batch
          if (batch.nextOffset === null) return
          offset = batch.nextOffset
        }
      },
      applyMutations: (batch) => invoke('library_apply_mutations', { batch }),
      startImport: (request) => invoke<string>('library_start_import', {
        request: {
          rootPath: request.rootPath ?? null,
          filePaths: request.filePaths ?? [],
          targetGroupId: request.targetGroupId ?? null,
        },
      }),
      cancelImport: (sessionId) => invoke('library_cancel_import', { sessionId }),
      undoLastImport: () => invoke('library_undo_last_import'),
      onImportProgress: (listener) => {
        let disposed = false
        const unlisten = listen<ImportProgress>('import-progress', (event) => {
          if (!disposed) listener(event.payload)
        })
        return () => {
          disposed = true
          void unlisten.then((stop) => stop())
        }
      },
    },
    audio: {
      getStreamUrl: (sampleId) => invoke<string>('audio_get_stream_url', { sampleId }),
      readSampleBytes: async (sampleId, signal) => {
        const streamUrl = await invoke<string>('audio_get_stream_url', { sampleId })
        const response = await fetch(`${streamUrl}?full=1`, { signal })
        if (!response.ok) throw new Error(`读取素材失败：HTTP ${response.status}`)
        return response.arrayBuffer()
      },
      getWaveform: (sampleId) => invoke('audio_get_waveform', { sampleId }),
    },
    legacyStorage: null,
    copySettings: {
      get: () => invoke<CopySettings>('copy_settings_get'),
      set: (settings) => invoke('copy_settings_set', { settings }),
    },
    files: {
      readAsBuffer: async (filePath) => {
        const bytes = await invoke<number[]>('lyrics_read_text', { filePath })
        return new Uint8Array(bytes).buffer
      },
      createLyricsFiles: (payload) => invoke<LyricsFilesResult>('lyrics_create_files', { payload }),
    },
    shell: {
      revealPath: (filePath) => { void revealItemInDir(filePath) },
      openExternal: (url) => { void openUrl(url) },
    },
    drag: {
      start: ({ sampleIds }) => invoke<DragResult>('drag_start', { sampleIds }),
    },
    updater: {
      getState: async () => {
        await getCurrentVersion()
        return updateState
      },
      check: async () => {
        const currentVersion = await getCurrentVersion()
        publishUpdate({ phase: 'checking', message: null })
        try {
          pendingUpdate?.close().catch(() => undefined)
          pendingUpdate = await check()
          if (!pendingUpdate) {
            publishUpdate({ phase: 'up-to-date', currentVersion, availableVersion: null, action: 'none' })
          } else {
            publishUpdate({
              phase: 'available',
              currentVersion,
              availableVersion: pendingUpdate.version,
              action: 'download-and-restart',
            })
          }
        } catch (error) {
          publishUpdate({ phase: 'error', message: String(error), action: 'none' })
        }
        return updateState
      },
      start: async () => {
        if (!pendingUpdate) return
        let downloaded = 0
        let total = 0
        publishUpdate({ phase: 'downloading', progressPercent: 0 })
        await pendingUpdate.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0
          if (event.event === 'Progress') downloaded += event.data.chunkLength
          publishUpdate({
            phase: event.event === 'Finished' ? 'installing' : 'downloading',
            progressPercent: total > 0 ? Math.min(100, downloaded / total * 100) : null,
          })
        })
        publishUpdate({ phase: 'installing', progressPercent: 100 })
        await invoke('app_restart')
      },
      onState: (listener) => {
        updateListeners.add(listener)
        return () => updateListeners.delete(listener)
      },
    },
  }
}

let activeBridge: DesktopBridge | null = null

export function getDesktopBridge(): DesktopBridge {
  if (activeBridge) return activeBridge
  if (isTauri()) {
    activeBridge = createTauriDesktopBridge()
    return activeBridge
  }
  if (typeof window === 'undefined' || !window.electronAPI) {
    throw new Error('Desktop bridge is unavailable in this runtime')
  }
  activeBridge = createElectronDesktopBridge(window.electronAPI)
  return activeBridge
}

export function getDesktopBridgeIfAvailable(): DesktopBridge | null {
  if (activeBridge) return activeBridge
  if (typeof window === 'undefined') return null
  if (isTauri()) {
    activeBridge = createTauriDesktopBridge()
    return activeBridge
  }
  if (!window.electronAPI) return null
  activeBridge = createElectronDesktopBridge(window.electronAPI)
  return activeBridge
}

export function setDesktopBridgeForTests(bridge: DesktopBridge | null): void {
  activeBridge = bridge
}
