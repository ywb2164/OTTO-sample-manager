import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import Store from 'electron-store'
import { cleanupManagedCopies, createManagedCopy } from './copyManager'

interface ScannedFolderNode {
  name: string
  path: string
  files: string[]
  children: ScannedFolderNode[]
}

// ------------------------------
// electron-store 初始化
// ------------------------------
const store = new Store({
  name: 'sample-manager-data',
  defaults: {
    samples: {},
    groups: {},
    copySettings: {
      enableAutoCopy: true,
      keepCopies: false,
    },
    settings: {
      windowAlwaysOnTop: true,
      windowOpacity: 1.0,
      windowWidth: 380,
      windowHeight: 700,
      windowX: undefined,
      windowY: undefined,
    }
  }
})

let mainWindow: BrowserWindow | null = null

// ------------------------------
// 创建主窗口
// ------------------------------
function createWindow(): void {
  const settings = store.get('settings') as any

  mainWindow = new BrowserWindow({
    width: settings.windowWidth || 380,
    height: settings.windowHeight || 700,
    x: settings.windowX,
    y: settings.windowY,
    minWidth: 300,
    minHeight: 500,
    maxWidth: 600,
    
    // 关键：悬浮窗配置
    frame: false,               // 无原生标题栏
    alwaysOnTop: settings.windowAlwaysOnTop ?? true,
    opacity: settings.windowOpacity ?? 1.0,

    // 防止拖拽操作时窗口消失在后面
    skipTaskbar: false,

    backgroundColor: '#0f0f17',
    
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  // 开发模式加载 vite dev server
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 保存窗口位置和大小
  mainWindow.on('close', () => {
    if (!mainWindow) return
    const [width, height] = mainWindow.getSize()
    const [x, y] = mainWindow.getPosition()
    const opacity = mainWindow.getOpacity()
    store.set('settings.windowWidth', width)
    store.set('settings.windowHeight', height)
    store.set('settings.windowX', x)
    store.set('settings.windowY', y)
    store.set('settings.windowOpacity', opacity)
  })
}

app.whenReady().then(() => {
  createWindow()
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async () => {
  const copySettings = (store.get('copySettings') as { enableAutoCopy?: boolean; keepCopies?: boolean } | undefined) ?? {}
  if (copySettings.keepCopies) return

  try {
    await cleanupManagedCopies()
  } catch {
    // 清理失败时不阻塞退出
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ==============================
// IPC 处理器
// ==============================

// ------------------------------
// 窗口控制
// ------------------------------
ipcMain.on('window-close', () => mainWindow?.close())
ipcMain.on('window-minimize', () => mainWindow?.minimize())

ipcMain.handle('window-get-always-on-top', () => {
  return mainWindow?.isAlwaysOnTop() ?? true
})

ipcMain.handle('window-get-opacity', () => {
  return mainWindow?.getOpacity() ?? 1.0
})

ipcMain.on('window-set-always-on-top', (_, value: boolean) => {
  mainWindow?.setAlwaysOnTop(value, 'floating')
  store.set('settings.windowAlwaysOnTop', value)
})

ipcMain.on('window-set-opacity', (_, value: number) => {
  mainWindow?.setOpacity(value)
})

// 拖动无边框窗口
ipcMain.on('window-drag-start', () => {
  // 通过鼠标位置移动窗口
  // 实际实现在渲染进程用 -webkit-app-region: drag 的CSS
})

// ------------------------------
// 文件导入
// ------------------------------
ipcMain.handle('dialog-open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '导入音频采样',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频文件', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aiff', 'aif', 'm4a'] }
    ]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('dialog-open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '导入整个文件夹',
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

// 扫描文件夹结构，保留根目录与层级
ipcMain.handle('scan-folder', async (_, folderPath: string) => {
  const audioExts = ['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.aif', '.m4a']

  function scanDir(dir: string): ScannedFolderNode | null {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      const node: ScannedFolderNode = {
        name: dir.replace(/\\/g, '/').split('/').pop() || dir,
        path: dir,
        files: [],
        children: [],
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          const child = scanDir(fullPath)
          if (child) {
            node.children.push(child)
          }
        } else {
          const ext = entry.name.includes('.') ? `.${entry.name.split('.').pop()?.toLowerCase()}` : ''
          if (audioExts.includes(ext)) {
            node.files.push(fullPath)
          }
        }
      }

      return node
    } catch (e) {
      return null
    }
  }

  return scanDir(folderPath)
})

// 获取文件基础信息（不解码，只读元数据）
ipcMain.handle('get-file-info', async (_, filePath: string) => {
  try {
    const stat = statSync(filePath)
    return {
      exists: true,
      fileSize: stat.size,
    }
  } catch {
    return { exists: false, fileSize: 0 }
  }
})

// 批量验证文件是否仍然存在
ipcMain.handle('validate-files', async (_, filePaths: string[]) => {
  return filePaths.map(p => ({ path: p, valid: existsSync(p) }))
})

// 在系统文件管理器中显示文件
ipcMain.on('show-in-explorer', (_, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// ------------------------------
// 原生文件拖拽（核心功能）
// ------------------------------
ipcMain.on('drag-out-files', async (event, items: Array<{ id: string; filePath: string }>) => {
  // 验证所有文件存在
  const validItems = items.filter(item => existsSync(item.filePath))
  if (validItems.length === 0) return

  const copySettings = (store.get('copySettings') as { enableAutoCopy?: boolean; keepCopies?: boolean } | undefined) ?? {}
  const enableAutoCopy = copySettings.enableAutoCopy ?? true

  const preparedItems = enableAutoCopy
    ? await Promise.all(
        validItems.map(async (item) => {
          try {
            const copyRecord = await createManagedCopy(item)
            return {
              ...item,
              targetPath: copyRecord.filePath
            }
          } catch {
            return null
          }
        })
      )
    : validItems.map((item) => ({
        ...item,
        targetPath: item.filePath
      }))

  const availableItems = preparedItems.filter((item): item is { id: string; filePath: string; targetPath: string } => item !== null)
  if (availableItems.length === 0) return

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'resources/drag-icon.png')
    : join(__dirname, '../../resources/drag-icon.png')

  const startDragOptions: any = { file: availableItems[0].targetPath }
  if (existsSync(iconPath) && iconPath.endsWith('.png')) {
    startDragOptions.icon = iconPath
  }

  if (availableItems.length === 1) {
    event.sender.startDrag(startDragOptions)
  } else {
    // Electron's startDrag only officially supports dragging a single file via the `file` property.
    // To drag multiple files, you would typically need to rely on native drag and drop mechanisms
    // or create a temporary archive. For now, we will just drag the first file if multiple are selected,
    // or you can implement a more complex multi-file drag solution if your OS supports it via custom formats.
    // This fixes the TypeScript error where `files` is not a property of `Item`.
    event.sender.startDrag(startDragOptions)
  }
})

// ------------------------------
// 数据持久化
// ------------------------------
ipcMain.handle('store-get', (_, key: string) => {
  return store.get(key)
})

ipcMain.on('store-set', (_, key: string, value: unknown) => {
  store.set(key as any, value)
})

ipcMain.on('store-delete', (_, key: string) => {
  // @ts-ignore - store.delete is technically expecting specific keys but we use dynamic ones
  store.delete(key as any)
})

// 读取文件为ArrayBuffer
ipcMain.handle('read-file-buffer', async (_, filePath: string) => {
  const { readFile } = require('fs/promises')
  try {
    const buffer = await readFile(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } catch (e) {
    throw new Error(`Failed to read file: ${filePath}`)
  }
})
