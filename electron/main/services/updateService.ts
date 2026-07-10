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
  openPortableDownload?: () => Promise<void>
  onStateChange?: (state: UpdateState) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UpdateService {
  private state: UpdateState
  private installing = false
  private readonly updater: UpdaterAdapter
  private readonly portable: boolean
  private readonly openPortableDownload: () => Promise<void>
  private readonly onStateChange?: (state: UpdateState) => void

  constructor(options: UpdateServiceOptions) {
    this.updater = options.updater
    this.portable = options.portable ?? false
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

    this.setState({ phase: 'checking', progressPercent: null, message: null, action: 'none' })
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.setError(error)
    }
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
      this.setState({
        phase: this.portable ? 'unsupported' : 'available',
        availableVersion: info.version ?? null,
        progressPercent: null,
        message: this.portable ? '便携版需重新下载' : null,
        action: this.portable ? 'open-portable-download' : 'download-and-restart',
      })
    })
    this.updater.on('update-not-available', () => {
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
    this.updater.on('error', (error: unknown) => this.setError(error))
  }

  private setError(error: unknown): void {
    this.installing = false
    this.setState({
      phase: 'error',
      progressPercent: null,
      message: errorMessage(error),
      action: 'none',
    })
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onStateChange?.(this.getState())
  }
}
