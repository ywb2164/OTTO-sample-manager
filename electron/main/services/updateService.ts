import type { UpdateState } from '../../updateTypes'

type UpdaterListener = (...args: any[]) => void

export interface UpdaterAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: UpdaterListener): this
}

interface UpdateServiceOptions {
  updater: UpdaterAdapter
  currentVersion: string
  portable?: boolean
  retryDelaysMs?: readonly number[]
  openPortableDownload?: () => Promise<void>
  onStateChange?: (state: UpdateState) => void
}

const DEFAULT_METADATA_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const
const MISSING_UPDATE_METADATA_MESSAGE = '新版本发布文件正在准备中，正在自动重试…'

function isMissingUpdateMetadataError(error: unknown): boolean {
  const message = errorMessage(error)
  return /latest\.yml/i.test(message) && /(?:404|cannot find)/i.test(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UpdateService {
  private state: UpdateState
  private installing = false
  private readonly updater: UpdaterAdapter
  private readonly portable: boolean
  private readonly retryDelaysMs: readonly number[]
  private readonly openPortableDownload: () => Promise<void>
  private readonly onStateChange?: (state: UpdateState) => void
  private retryIndex = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: UpdateServiceOptions) {
    this.updater = options.updater
    this.portable = options.portable ?? false
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_METADATA_RETRY_DELAYS_MS
    this.openPortableDownload = options.openPortableDownload ?? (async () => undefined)
    this.onStateChange = options.onStateChange
    this.state = {
      phase: 'idle',
      currentVersion: options.currentVersion,
      availableVersion: null,
      progressPercent: null,
      message: null,
      action: 'none',
    }

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.bindUpdaterEvents()
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  async checkForUpdates(_options: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return this.getState()
    }

    this.clearRetry(true)
    this.setState({ phase: 'checking', progressPercent: null, message: null, action: 'none' })
    await this.runUpdateCheck()
    return this.getState()
  }

  async startUpdate(): Promise<void> {
    if (this.portable) {
      if (this.state.action === 'open-portable-download') {
        await this.openPortableDownload()
      }
      return
    }

    if (this.state.phase !== 'available') return
    this.setState({ phase: 'downloading', progressPercent: 0, action: 'none', message: null })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.setError(error)
    }
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.setState({ phase: 'checking', progressPercent: null, message: null, action: 'none' })
    })
    this.updater.on('update-available', (info: { version?: string }) => {
      this.clearRetry(true)
      this.setState({
        phase: this.portable ? 'unsupported' : 'available',
        availableVersion: info.version ?? null,
        progressPercent: null,
        message: this.portable ? '便携版需重新下载' : null,
        action: this.portable ? 'open-portable-download' : 'download-and-restart',
      })
    })
    this.updater.on('update-not-available', () => {
      this.clearRetry(true)
      this.setState({
        phase: 'up-to-date',
        availableVersion: null,
        progressPercent: null,
        message: null,
        action: 'none',
      })
    })
    this.updater.on('download-progress', (progress: { percent?: number }) => {
      const percent = Number.isFinite(progress.percent) ? Math.round(progress.percent!) : 0
      this.setState({ phase: 'downloading', progressPercent: percent, message: null, action: 'none' })
    })
    this.updater.on('update-downloaded', (info: { version?: string }) => {
      if (this.portable || this.installing) return
      this.installing = true
      this.setState({
        phase: 'downloaded',
        availableVersion: info.version ?? this.state.availableVersion,
        progressPercent: 100,
        message: null,
        action: 'none',
      })
      this.setState({ phase: 'installing' })
      this.updater.quitAndInstall(true, true)
    })
    this.updater.on('error', (error: unknown) => this.handleUpdaterError(error))
  }

  private async runUpdateCheck(): Promise<void> {
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.handleUpdaterError(error)
    }
  }

  private handleUpdaterError(error: unknown): void {
    if (isMissingUpdateMetadataError(error) && this.state.phase === 'checking') {
      if (this.retryTimer) return

      const delayMs = this.retryDelaysMs[this.retryIndex]
      if (delayMs !== undefined) {
        this.retryIndex += 1
        this.setState({
          phase: 'checking',
          progressPercent: null,
          message: MISSING_UPDATE_METADATA_MESSAGE,
          action: 'none',
        })
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.runUpdateCheck()
        }, delayMs)
        return
      }

      this.setError(error, '新版本发布文件暂时不可用，请稍后重试。')
      return
    }

    this.setError(error)
  }

  private clearRetry(resetIndex: boolean): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (resetIndex) this.retryIndex = 0
  }

  private setError(error: unknown, message = errorMessage(error)): void {
    this.installing = false
    this.clearRetry(false)
    this.setState({
      phase: 'error',
      progressPercent: null,
      message,
      action: 'none',
    })
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onStateChange?.(this.getState())
  }
}
