export {}

interface ElectronCheckForUpdatesOptions {
  silentIfNoUpdate?: boolean
  showErrors?: boolean
}

interface ElectronScannedFolderNode {
  name: string
  path: string
  files: string[]
  children: ElectronScannedFolderNode[]
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
      scanFolder: (folderPath: string) => Promise<ElectronScannedFolderNode | null>
      getFileInfo: (filePath: string) => Promise<{ exists: boolean; fileSize: number }>
      validateFiles: (filePaths: string[]) => Promise<{ path: string; valid: boolean }[]>
      showInExplorer: (filePath: string) => void
      openExternalLink: (url: string) => void
      dragOutFiles: (filePaths: string[]) => void
      storeGet: (key: string) => Promise<unknown>
      storeSet: (key: string, value: unknown) => void
      storeDelete: (key: string) => void
      readFileAsBuffer: (filePath: string) => Promise<ArrayBuffer>
      createLyricsFiles: (payload: {
        targetGroupName: string
        items: Array<{ id: string; sourcePath: string; fileName: string }>
      }) => Promise<{
        success: Array<{ id: string; sourcePath: string; targetPath: string; fileSize: number }>
        failed: Array<{ id: string; sourcePath: string; reason: string }>
        targetDir: string
      }>
      checkForUpdates: (options?: ElectronCheckForUpdatesOptions) => Promise<void>
    }
  }
}
