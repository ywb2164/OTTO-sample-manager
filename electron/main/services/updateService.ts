import { app, BrowserWindow, dialog, shell } from 'electron'

export interface UpdateManifest {
  latestVersion: string
  downloadUrlWindows: string
  notes?: string[]
}

export interface UpdateServiceOptions {
  manifestUrl: string
  requestTimeoutMs?: number
  getWindow?: () => BrowserWindow | null
}

export interface CheckForUpdatesOptions {
  silentIfNoUpdate?: boolean
  showErrors?: boolean
}

export interface UpdateProvider {
  checkForUpdates(options?: CheckForUpdatesOptions): Promise<void>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function parseSemver(version: string): number[] | null {
  const normalized = normalizeVersion(version)
  const mainPart = normalized.split('-')[0]
  const segments = mainPart.split('.')

  if (segments.length === 0 || segments.some((segment) => !/^\d+$/.test(segment))) {
    return null
  }

  return segments.map((segment) => Number(segment))
}

export function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)

  if (!leftParts || !rightParts) {
    throw new Error(`Invalid semver comparison: "${left}" vs "${right}"`)
  }

  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0

    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }

  return 0
}

async function fetchUpdateManifest(
  manifestUrl: string,
  requestTimeoutMs: number,
): Promise<UpdateManifest> {
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), requestTimeoutMs)

  try {
    const response = await fetch(manifestUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: abortController.signal,
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Update manifest request failed with status ${response.status}`)
    }

    const manifest = (await response.json()) as Partial<UpdateManifest>

    if (
      typeof manifest.latestVersion !== 'string' ||
      typeof manifest.downloadUrlWindows !== 'string'
    ) {
      throw new Error('Update manifest is missing required fields')
    }

    return {
      latestVersion: manifest.latestVersion,
      downloadUrlWindows: manifest.downloadUrlWindows,
      notes: Array.isArray(manifest.notes)
        ? manifest.notes.filter((note): note is string => typeof note === 'string')
        : [],
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

function buildUpdateMessage(currentVersion: string, manifest: UpdateManifest): string {
  const notes = manifest.notes && manifest.notes.length > 0 ? manifest.notes : ['暂无更新说明']
  const noteLines = notes.map((note) => `• ${note}`).join('\n')

  return [
    `当前版本：${currentVersion}`,
    `最新版本：${manifest.latestVersion}`,
    '',
    '更新说明：',
    noteLines,
  ].join('\n')
}

export class JsonUpdateService implements UpdateProvider {
  private readonly manifestUrl: string
  private readonly requestTimeoutMs: number
  private readonly getWindow: () => BrowserWindow | null

  constructor(options: UpdateServiceOptions) {
    this.manifestUrl = options.manifestUrl
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.getWindow = options.getWindow ?? (() => BrowserWindow.getFocusedWindow() ?? null)
  }

  async checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<void> {
    const { silentIfNoUpdate = true, showErrors = false } = options

    try {
      const manifest = await fetchUpdateManifest(this.manifestUrl, this.requestTimeoutMs)
      const currentVersion = app.getVersion()

      if (compareSemver(manifest.latestVersion, currentVersion) <= 0) {
        if (!silentIfNoUpdate) {
          await dialog.showMessageBox(this.getWindow(), {
            type: 'info',
            title: '检查更新',
            message: '当前已是最新版本',
            detail: `当前版本：${currentVersion}`,
          })
        }
        return
      }

      const result = await dialog.showMessageBox(this.getWindow(), {
        type: 'info',
        title: '发现新版本',
        buttons: ['立即下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: '检测到新版本可用',
        detail: buildUpdateMessage(currentVersion, manifest),
      })

      if (result.response === 0) {
        await shell.openExternal(manifest.downloadUrlWindows)
      }
    } catch (error) {
      console.warn('[update] check failed', error)

      if (showErrors) {
        await dialog.showMessageBox(this.getWindow(), {
          type: 'warning',
          title: '检查更新失败',
          message: '暂时无法检查更新，请稍后重试。',
        })
      }
    }
  }
}
