export {}

interface ElectronUpdateState {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'unsupported' | 'error'
  currentVersion: string
  availableVersion: string | null
  progressPercent: number | null
  message: string | null
  action: 'none' | 'download-and-restart' | 'open-portable-download'
}

interface ElectronScannedFolderNode {
  name: string
  path: string
  files: string[]
  children: ElectronScannedFolderNode[]
}

interface ElectronScanFolderResult {
  root: ElectronScannedFolderNode | null
  scannedFileCount: number
  failures: Array<{ path: string; stage: 'scan'; reason: string }>
}

declare global {
  interface Window {
    electronAPI: {
      closeWindow: () => void
      minimizeWindow: () => void
      getAlwaysOnTop: () => Promise<boolean>
      setAlwaysOnTop: (value: boolean) => void
      getOpacity: () => Promise<number>
      setOpacity: (value: number) => void
      getAppVersion: () => Promise<string>
      openFileDialog: () => Promise<string[]>
      openFolderDialog: () => Promise<string | null>
      openLyricsFileDialog: () => Promise<string | null>
      scanFolder: (folderPath: string) => Promise<ElectronScanFolderResult>
      getFileInfo: (filePath: string) => Promise<{ exists: boolean; fileSize: number }>
      validateFiles: (filePaths: string[]) => Promise<{ path: string; valid: boolean }[]>
      showInExplorer: (filePath: string) => void
      openExternalLink: (url: string) => void
      dragOutFiles: (filePaths: string[]) => void
      storeGet: (key: string) => Promise<unknown>
      storeSet: (key: string, value: unknown) => Promise<void>
      storeDelete: (key: string) => Promise<void>
      readFileAsBuffer: (filePath: string) => Promise<ArrayBuffer>
      createLyricsFiles: (payload: {
        targetGroupName: string
        items: Array<{ id: string; sourcePath: string; fileName: string }>
      }) => Promise<{
        success: Array<{ id: string; sourcePath: string; targetPath: string; fileSize: number }>
        failed: Array<{ id: string; sourcePath: string; reason: string }>
        targetDir: string | null
      }>
      getUpdateState: () => Promise<ElectronUpdateState>
      checkForUpdates: (options?: { manual?: boolean }) => Promise<ElectronUpdateState>
      startUpdate: () => Promise<void>
      onUpdateState: (listener: (state: ElectronUpdateState) => void) => () => void
    }
  }
}
