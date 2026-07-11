import { app, BrowserWindow, ipcMain, dialog, nativeImage, screen, shell } from 'electron'
import { dirname, join } from 'path'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import Store from 'electron-store'
import { autoUpdater } from 'electron-updater'
import { cleanupManagedCopiesSync, createManagedCopySync, getLyricsAssembliesDir } from './copyManager'
import { mergeStagedLyricsAssemblies, migratePersistedSamplePaths } from './copyMigration'
import { UpdateService } from './services/updateService'
import { scanAudioFolder } from './folderScanner'
import { getFilesInfo } from './fileInfo'
import { calculatePrimarySidebarBounds } from './windowPlacement'

const isolatedUserDataDir = process.env.OTTO_USER_DATA_DIR
if (isolatedUserDataDir) {
  app.setPath('userData', isolatedUserDataDir)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

// ------------------------------
// electron-store 初始化
// ------------------------------
const store = new Store({
  name: 'sample-manager-data',
  defaults: {
    samples: {},
    groups: {},
    dragCounts: {},
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
const PORTABLE_RELEASE_URL =
  'https://github.com/ywb2164/OTTO-sample-manager/releases/latest'
const FALLBACK_DRAG_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn7L6kAAAAASUVORK5CYII='

const isPortableBuild = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)

if (process.env.OTTO_UPDATE_FEED_URL) {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: process.env.OTTO_UPDATE_FEED_URL,
  })
}

const updateService = new UpdateService({
  updater: autoUpdater,
  currentVersion: app.getVersion(),
  portable: isPortableBuild,
  openPortableDownload: async () => {
    await shell.openExternal(PORTABLE_RELEASE_URL)
  },
  onStateChange: (state) => {
    mainWindow?.webContents.send('update-state', state)
  },
})

function createFallbackDragIcon() {
  return nativeImage.createFromDataURL(FALLBACK_DRAG_ICON_DATA_URL).resize({ width: 32, height: 32 })
}

function resolveDragIcon() {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'resources/drag-icon.png'),
        join(process.resourcesPath, 'resources/icon.png'),
      ]
    : [
        join(app.getAppPath(), 'resources/drag-icon.png'),
        join(app.getAppPath(), 'resources/icon.png'),
        join(app.getAppPath(), 'build/icon.png'),
      ]

  for (const iconPath of candidates) {
    try {
      const exists = existsSync(iconPath)
      if (import.meta.env.DEV) {
        console.debug('[drag icon] trying path=', iconPath)
        console.debug('[drag icon] file exists=', exists)
      }
      if (!exists) continue

      const icon = nativeImage.createFromPath(iconPath)
      if (import.meta.env.DEV) {
        console.debug('[drag icon] isEmpty=', icon.isEmpty())
        console.debug('[drag icon] size=', icon.getSize())
      }
      if (!icon.isEmpty()) {
        if (import.meta.env.DEV) {
          console.debug('[drag icon] using png file')
        }
        return icon
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.debug('[drag icon] failed to load path=', iconPath, error)
      }
    }
  }

  if (import.meta.env.DEV) {
    console.debug('[drag icon] fallback to generated native image')
  }
  const fallbackIcon = createFallbackDragIcon()
  if (import.meta.env.DEV) {
    console.debug('[drag icon] fallback dataUrl=', FALLBACK_DRAG_ICON_DATA_URL)
    console.debug('[drag icon] isEmpty=', fallbackIcon.isEmpty())
    console.debug('[drag icon] size=', fallbackIcon.getSize())
  }
  return fallbackIcon
}

// ------------------------------
// 创建主窗口
// ------------------------------
function createWindow(): void {
  const settings = store.get('settings') as any
  const workArea = screen.getPrimaryDisplay().workArea
  const bounds = calculatePrimarySidebarBounds(workArea, {
    width: settings.windowWidth,
    height: settings.windowHeight,
  })

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(300, workArea.width),
    minHeight: Math.min(500, workArea.height),
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

  // 仅保存尺寸和透明度；下次启动重新贴合主屏右上角。
  mainWindow.on('close', () => {
    if (!mainWindow) return
    const [width, height] = mainWindow.getSize()
    const opacity = mainWindow.getOpacity()
    store.set('settings.windowWidth', width)
    store.set('settings.windowHeight', height)
    store.set('settings.windowOpacity', opacity)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function migrateLegacyCopyData(): Promise<void> {
  if (!app.isPackaged) return

  const userDataRoot = app.getPath('userData')
  const targetCopyRoot = join(userDataRoot, 'Copy')
  const stagingRoot = join(userDataRoot, 'copy-migration')
  const legacyCopyRoot = join(dirname(app.getPath('exe')), 'Copy')

  await mergeStagedLyricsAssemblies(stagingRoot, targetCopyRoot)

  const storedSamples = store.get('samples') as Record<string, { filePath?: unknown; [key: string]: unknown }> | undefined
  if (!storedSamples) return

  const migration = migratePersistedSamplePaths(
    storedSamples,
    legacyCopyRoot,
    targetCopyRoot,
    existsSync,
  )

  if (migration.changed) {
    store.set('samples', migration.samples)
  }
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      await migrateLegacyCopyData()
    } catch (error) {
      console.error('[copy migration] failed, preserving staged data for retry', error)
    }

    createWindow()
    if (app.isPackaged || process.env.OTTO_UPDATE_FEED_URL) {
      void updateService.checkForUpdates()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    const copySettings = (store.get('copySettings') as { enableAutoCopy?: boolean; keepCopies?: boolean } | undefined) ?? {}
    console.debug('[cleanup] copySettings=', copySettings)
    if (copySettings.keepCopies) {
      console.debug('[cleanup] preserveCopies=true, skip drag-copies cleanup')
      return
    }

    try {
      console.debug('[cleanup] preserveCopies=false, remove drag-copies')
      cleanupManagedCopiesSync()
      store.set('dragCounts', {})
    } catch {
      // 清理失败时不阻塞退出
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

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

ipcMain.handle('app-get-version', () => {
  return app.getVersion()
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

ipcMain.handle('dialog-open-lyrics-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '选择活字印刷文本 txt',
    properties: ['openFile'],
    filters: [
      { name: '文本文件', extensions: ['txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  })
  return result.canceled ? null : result.filePaths[0]
})

// 扫描文件夹结构，保留根目录与层级
ipcMain.handle('scan-folder', async (_, folderPath: string) => {
  return scanAudioFolder(folderPath)
})

// 批量获取文件基础信息（不解码、不读取音频正文）。
ipcMain.handle('get-files-info', async (_, filePaths: string[]) => getFilesInfo(filePaths))

// 批量验证文件是否仍然存在
ipcMain.handle('validate-files', async (_, filePaths: string[]) => {
  return filePaths.map(p => ({ path: p, valid: existsSync(p) }))
})

// 在系统文件管理器中显示文件
ipcMain.on('show-in-explorer', (_, filePath: string) => {
  shell.showItemInFolder(filePath)
})

ipcMain.on('open-external-link', (_, url: string) => {
  shell.openExternal(url)
})

ipcMain.handle('update-get-state', () => updateService.getState())
ipcMain.handle('update-check', async (_, options?: { manual?: boolean }) => updateService.checkForUpdates(options))
ipcMain.handle('update-start', async () => updateService.startUpdate())

// ------------------------------
// 原生文件拖拽（核心功能）
// ------------------------------
ipcMain.on('drag-out-files', (event, filePaths: string[]) => {
  try {
    const validPaths = filePaths.filter(filePath => existsSync(filePath))
    if (import.meta.env.DEV) {
      console.debug('[drag-out][main] incoming', filePaths)
      console.debug('[drag-out][main] valid', validPaths)
      console.debug('[drag-out][main] requestedCount=', filePaths.length)
      console.debug('[drag-out][main] draggedCount=', validPaths.length > 0 ? 1 : 0)
    }
    if (validPaths.length === 0) return

    const originalPath = validPaths[0]
    const copySettings = (store.get('copySettings') as { enableAutoCopy?: boolean; keepCopies?: boolean } | undefined) ?? {}
    const enableAutoCopy = copySettings.enableAutoCopy ?? true
    const dragCounts = {
      ...((store.get('dragCounts') as Record<string, number> | undefined) ?? {})
    }

    const currentDragCount = dragCounts[originalPath] ?? 0
    const useOriginal = !enableAutoCopy || currentDragCount === 0

    let targetPath = originalPath
    if (!useOriginal) {
      const copyRecord = createManagedCopySync({
        id: originalPath,
        filePath: originalPath,
      })
      targetPath = copyRecord.filePath
    }

    dragCounts[originalPath] = currentDragCount + 1
    store.set('dragCounts', dragCounts)

    if (import.meta.env.DEV) {
      console.debug('[drag policy] sampleKey=', originalPath)
      console.debug('[drag policy] dragCount=', currentDragCount)
      console.debug('[drag policy] autoCopyEnabled=', enableAutoCopy)
      console.debug('[drag policy] useOriginal=', useOriginal)
      console.debug('[drag policy] chosenPath=', targetPath)
      console.debug('[drag policy] requestedCount=', filePaths.length)
      console.debug('[drag policy] draggedCount=1')
    }

    const dragIcon = resolveDragIcon()
    const startDragOptions = {
      file: targetPath,
      icon: dragIcon,
    }

    if (import.meta.env.DEV) {
      console.debug('[drag-out][main] startDrag', startDragOptions)
    }

    // 回归 1.0.0：当前仍只拖出第一个有效文件
    event.sender.startDrag(startDragOptions)
  } catch (error) {
    console.error('[drag-out][main] startDrag failed', error)
  }
})

// ------------------------------
// 数据持久化
// ------------------------------
ipcMain.handle('store-get', (_, key: string) => {
  return store.get(key)
})

ipcMain.handle('store-set', (_, key: string, value: unknown) => {
  store.set(key as any, value)
})

ipcMain.handle('store-delete', (_, key: string) => {
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'lyrics_group'
}

ipcMain.handle('lyrics-create-files', async (_, payload: {
  targetGroupName: string
  items: Array<{ id: string; sourcePath: string; fileName: string }>
}) => {
  const lyricsAssembliesRoot = await getLyricsAssembliesDir()
  const baseDir = join(
    lyricsAssembliesRoot,
    `${sanitizePathSegment(payload.targetGroupName)}_${Date.now()}`
  )

  const success: Array<{ id: string; sourcePath: string; targetPath: string; fileSize: number }> = []
  const failed: Array<{ id: string; sourcePath: string; reason: string }> = []
  let hasCreatedTargetDir = false

  for (const item of payload.items) {
    try {
      if (!existsSync(item.sourcePath)) {
        failed.push({ id: item.id, sourcePath: item.sourcePath, reason: 'source-missing' })
        continue
      }

      if (!hasCreatedTargetDir) {
        mkdirSync(baseDir, { recursive: true })
        hasCreatedTargetDir = true
      }

      const targetPath = join(baseDir, sanitizePathSegment(item.fileName))
      copyFileSync(item.sourcePath, targetPath)
      const fileStat = statSync(targetPath)
      success.push({
        id: item.id,
        sourcePath: item.sourcePath,
        targetPath,
        fileSize: fileStat.size,
      })
    } catch {
      failed.push({ id: item.id, sourcePath: item.sourcePath, reason: 'copy-failed' })
    }
  }

  return { success, failed, targetDir: hasCreatedTargetDir ? baseDir : null }
})
