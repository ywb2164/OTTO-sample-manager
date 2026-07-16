export interface Sample {
  id: string
  fileName: string        // 显示用文件名（不含扩展名）
  fileExt: string         // 扩展名，如 .wav .mp3
  filePath: string        // 完整路径（唯一性依据）
  folderId?: string | null
  originalId: string
  isCopy: boolean
  copyIndex: number
  duration: number        // 时长（秒）
  sampleRate: number
  channels: number
  fileSize: number
  groupIds: string[]
  importedAt: number
  // 运行时数据，不持久化
  waveformData?: Float32Array
  isDecoded: boolean      // 是否已预解码
  isFileValid: boolean    // 文件是否仍然存在
}

// Compact library identity kept for every SQLite row. Heavy path/audio metadata
// is loaded into Sample objects only for the bounded set of visible pages.
export interface SampleSummary {
  kind: 'sample-summary'
  id: string
  fileName: string
  fileExt: string
  folderId: string | null
  groupIds: string[]
  importedAt: number
  pageIndex: number
}

export type SampleListEntry = Sample | SampleSummary

export interface SampleGroup {
  id: string
  name: string
  color: string
  sampleIds: string[]
}

export interface SampleFolder {
  id: string
  name: string
  path: string  // 文件夹路径
  sampleIds: string[]  // 当前文件夹直接包含的样本ID
  childFolderIds: string[]
  parentId: string | null
  rootId: string
  depth: number
  importedAt: number
  isExpanded: boolean  // 是否展开
  order: number  // 排序顺序
  isRenaming: boolean  // 是否正在重命名
}

export interface ScannedFolderNode {
  name: string
  path: string
  files: string[]
  children: ScannedFolderNode[]
}

export type ImportFailureStage = 'scan' | 'metadata' | 'commit'

export interface ImportFailure {
  path: string
  stage: ImportFailureStage
  reason: string
}

export interface ScanFolderResult {
  root: ScannedFolderNode | null
  scannedFileCount: number
  failures: ImportFailure[]
}

export type ImportCandidate = Omit<Sample, 'groupIds'>

export interface ImportSummary {
  scanned: number
  added: number
  linkedToGroup: number
  skipped: number
  failed: number
  targetGroupId: string | null
  failures: ImportFailure[]
}

export interface ImportUndoReceipt {
  transactionId: string
  createdAt: number
  expectedLibraryRevision: number
  targetGroupId: string | null
  addedSampleIds: string[]
  addedGroupLinks: Array<{ sampleId: string; groupId: string }>
  previousSampleFolderIds: Array<{ sampleId: string; folderId: string | null }>
  addedFolderIds: string[]
  previousFolders: SampleFolder[]
  previousFolderOrder: string[]
  summary: ImportSummary
}

export interface UndoImportSummary {
  removedSamples: number
  removedGroupLinks: number
  restoredFolders: number
}

export interface StoredImportUndoState {
  libraryRevision: number
  receipt: ImportUndoReceipt | null
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'unsupported'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  progressPercent: number | null
  message: string | null
  action: 'none' | 'download-and-restart' | 'open-portable-download'
}

export interface CommitImportPayload {
  candidates: ImportCandidate[]
  folders: SampleFolder[]
  rootFolderIds: string[]
  targetGroupId: string | null
  scannedFileCount: number
  failures: ImportFailure[]
}

export interface StoredFolderState {
  folders: Record<string, SampleFolder>
  folderOrder: string[]
}

export interface PlayerState {
  currentSampleId: string | null
  isPlaying: boolean
  currentTime: number
  duration: number
}

export interface AppSettings {
  windowAlwaysOnTop: boolean
  windowWidth: number
  windowHeight: number
  windowX?: number
  windowY?: number
  expandFoldersOnSearch: boolean
}

export interface CopySettings {
  enableAutoCopy: boolean
  keepCopies: boolean
}

// IPC通信的类型
export interface DragStartPayload {
  items: Array<{
    id: string
    filePath: string
  }>
}

export interface ImportResult {
  success: Sample[]
  failed: string[]        // 导入失败的路径
}
