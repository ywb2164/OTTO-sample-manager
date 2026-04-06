import { app, BrowserWindow, dialog, shell } from 'electron'
import type { MessageBoxOptions } from 'electron'

interface GitHubReleaseAsset {
  name?: string
  browser_download_url?: string
}

interface GitHubLatestReleaseResponse {
  tag_name?: string
  body?: string
  html_url?: string
  assets?: GitHubReleaseAsset[]
}

export interface UpdateInfo {
  latestVersion: string
  downloadUrlWindows: string
  notes: string[]
}

export interface UpdateServiceOptions {
  apiUrl: string
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

function cleanupMarkdownText(body: string): string[] {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[`*_>~]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function isPreferredWindowsInstallerAsset(asset: GitHubReleaseAsset): boolean {
  const fileName = asset.name?.toLowerCase() ?? ''

  return (
    fileName.includes('sample-manager') &&
    fileName.includes('setup') &&
    fileName.endsWith('.exe')
  )
}

function resolveDownloadUrl(release: GitHubLatestReleaseResponse): string {
  const preferredAsset = (release.assets ?? []).find(isPreferredWindowsInstallerAsset)

  if (preferredAsset?.browser_download_url) {
    return preferredAsset.browser_download_url
  }

  if (typeof release.html_url === 'string' && release.html_url.length > 0) {
    return release.html_url
  }

  throw new Error('GitHub release does not contain a valid download url')
}

async function fetchLatestReleaseInfo(
  apiUrl: string,
  requestTimeoutMs: number,
): Promise<UpdateInfo> {
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), requestTimeoutMs)

  try {
    console.info('[update] GitHub API URL =', apiUrl)

    const response = await fetch(apiUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: abortController.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OTTO-sample-manager',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    })

    if (!response.ok) {
      throw new Error(`GitHub latest release request failed with status ${response.status}`)
    }

    const release = (await response.json()) as GitHubLatestReleaseResponse

    if (typeof release.tag_name !== 'string' || release.tag_name.length === 0) {
      throw new Error('GitHub latest release response is missing tag_name')
    }

    const normalizedRemoteVersion = normalizeVersion(release.tag_name)

    console.info('[update] GitHub raw tag_name =', release.tag_name)
    console.info('[update] Normalized remote version =', normalizedRemoteVersion)

    return {
      latestVersion: normalizedRemoteVersion,
      downloadUrlWindows: resolveDownloadUrl(release),
      // body 来自 GitHub release markdown，先做基础纯文本整理再展示到弹窗里。
      notes: typeof release.body === 'string' ? cleanupMarkdownText(release.body) : [],
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

function buildUpdateMessage(currentVersion: string, updateInfo: UpdateInfo): string {
  const notes = updateInfo.notes.length > 0 ? updateInfo.notes : ['暂无更新说明']
  const noteLines = notes.map((note) => `• ${note}`).join('\n')

  return [
    `当前版本：${currentVersion}`,
    `最新版本：${updateInfo.latestVersion}`,
    '',
    '更新说明：',
    noteLines,
  ].join('\n')
}

export class GitHubReleaseUpdateService implements UpdateProvider {
  private readonly apiUrl: string
  private readonly requestTimeoutMs: number
  private readonly getWindow: () => BrowserWindow | null

  constructor(options: UpdateServiceOptions) {
    this.apiUrl = options.apiUrl
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.getWindow = options.getWindow ?? (() => BrowserWindow.getFocusedWindow() ?? null)
  }

  private getDialogWindow(): BrowserWindow | undefined {
    return this.getWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined
  }

  private showMessageBox(options: MessageBoxOptions) {
    const dialogWindow = this.getDialogWindow()
    return dialogWindow
      ? dialog.showMessageBox(dialogWindow, options)
      : dialog.showMessageBox(options)
  }

  async checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<void> {
    const { silentIfNoUpdate = true, showErrors = false } = options

    try {
      const updateInfo = await fetchLatestReleaseInfo(this.apiUrl, this.requestTimeoutMs)
      const currentVersion = app.getVersion()
      const compareResult = compareSemver(updateInfo.latestVersion, currentVersion)

      console.info('[update] Local app version =', currentVersion)
      console.info('[update] Version compare result =', compareResult)

      if (compareResult <= 0) {
        if (!silentIfNoUpdate) {
          await this.showMessageBox({
            type: 'info',
            title: '检查更新',
            message: '当前已是最新版本',
            detail: `当前版本：${currentVersion}`,
          })
        }
        return
      }

      const result = await this.showMessageBox({
        type: 'info',
        title: '发现新版本',
        buttons: ['立即下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: '检测到新版本可用',
        detail: buildUpdateMessage(currentVersion, updateInfo),
      })

      if (result.response === 0) {
        await shell.openExternal(updateInfo.downloadUrlWindows)
      }
    } catch (error) {
      console.warn('[update] check failed', error)

      if (showErrors) {
        await this.showMessageBox({
          type: 'warning',
          title: '检查更新失败',
          message: '暂时无法检查更新，请稍后重试。',
        })
      }
    }
  }
}
