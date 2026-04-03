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

export interface StructuredImportPayload {
  samples: Sample[]
  folders: SampleFolder[]
  rootFolderIds: string[]
  targetGroupId: string | null
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

declare global {
  interface Window {
    electronAPI: any
  }
}
