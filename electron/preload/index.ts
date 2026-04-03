import { contextBridge, ipcRenderer } from 'electron'

// 向渲染进程暴露安全的API
contextBridge.exposeInMainWorld('electronAPI', {
  
  // 窗口控制
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  getAlwaysOnTop: () => ipcRenderer.invoke('window-get-always-on-top'),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.send('window-set-always-on-top', value),
  getOpacity: () => ipcRenderer.invoke('window-get-opacity'),
  setOpacity: (value: number) => ipcRenderer.send('window-set-opacity', value),
  
  // 文件操作
  openFileDialog: () => ipcRenderer.invoke('dialog-open-files'),
  openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),
  scanFolder: (folderPath: string) => ipcRenderer.invoke('scan-folder', folderPath),
  getFileInfo: (filePath: string) => ipcRenderer.invoke('get-file-info', filePath),
  validateFiles: (filePaths: string[]) => ipcRenderer.invoke('validate-files', filePaths),
  showInExplorer: (filePath: string) => ipcRenderer.send('show-in-explorer', filePath),
  
  // 拖拽
  dragOutFiles: (items: Array<{ id: string; filePath: string }>) => ipcRenderer.send('drag-out-files', items),
  
  // 持久化存储
  storeGet: (key: string) => ipcRenderer.invoke('store-get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.send('store-set', key, value),
  storeDelete: (key: string) => ipcRenderer.send('store-delete', key),
  
  // 读取文件为ArrayBuffer（用于音频解码）
  readFileAsBuffer: (filePath: string): Promise<ArrayBuffer> => {
    return ipcRenderer.invoke('read-file-buffer', filePath)
  }
})

// TypeScript类型声明
declare global {
  interface ScannedFolderNode {
    name: string
    path: string
    files: string[]
    children: ScannedFolderNode[]
  }

  interface Window {
    electronAPI: {
      closeWindow: () => void
      minimizeWindow: () => void
      getAlwaysOnTop: () => Promise<boolean>
      setAlwaysOnTop: (value: boolean) => void
      getOpacity: () => Promise<number>
      setOpacity: (value: number) => void
      openFileDialog: () => Promise<string[]>
      openFolderDialog: () => Promise<string | null>
      scanFolder: (folderPath: string) => Promise<ScannedFolderNode | null>
      getFileInfo: (filePath: string) => Promise<{ exists: boolean; fileSize: number }>
      validateFiles: (filePaths: string[]) => Promise<{ path: string; valid: boolean }[]>
      showInExplorer: (filePath: string) => void
      dragOutFiles: (items: Array<{ id: string; filePath: string }>) => void
      storeGet: (key: string) => Promise<unknown>
      storeSet: (key: string, value: unknown) => void
      storeDelete: (key: string) => void
      readFileAsBuffer: (filePath: string) => Promise<ArrayBuffer>
    }
  }
}
