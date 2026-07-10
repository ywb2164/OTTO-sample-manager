import { describe, expect, it, vi } from 'vitest'
import { UpdateService, type UpdaterAdapter } from './updateService'

class FakeUpdater implements UpdaterAdapter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => undefined)
  downloadUpdate = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
  private listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: any[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args))
  }
}

describe('UpdateService', () => {
  it('checks silently without downloading until the user starts the update', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService({ updater, currentVersion: '2.5.0' })

    await service.checkForUpdates()
    updater.emit('update-available', { version: '2.5.1' })

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '2.5.1',
      action: 'download-and-restart',
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    await service.startUpdate()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('maps progress and installs exactly once as soon as the download finishes', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService({ updater, currentVersion: '2.5.0' })
    updater.emit('update-available', { version: '2.5.1' })

    await service.startUpdate()
    updater.emit('download-progress', { percent: 42.4 })
    expect(service.getState()).toMatchObject({ phase: 'downloading', progressPercent: 42 })

    updater.emit('update-downloaded', { version: '2.5.1' })
    updater.emit('update-downloaded', { version: '2.5.1' })
    expect(service.getState().phase).toBe('installing')
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('recovers from errors and reports up-to-date checks', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService({ updater, currentVersion: '2.5.0' })

    updater.emit('update-not-available', { version: '2.5.0' })
    expect(service.getState()).toMatchObject({ phase: 'up-to-date', action: 'none' })

    updater.emit('error', new Error('network unavailable'))
    expect(service.getState()).toMatchObject({
      phase: 'error',
      message: 'network unavailable',
      action: 'none',
    })
  })

  it('never downloads or self-installs a portable build', async () => {
    const updater = new FakeUpdater()
    const openPortableDownload = vi.fn(async () => undefined)
    const service = new UpdateService({
      updater,
      currentVersion: '2.5.0',
      portable: true,
      openPortableDownload,
    })
    updater.emit('update-available', { version: '2.5.1' })

    expect(service.getState()).toMatchObject({
      phase: 'unsupported',
      action: 'open-portable-download',
      availableVersion: '2.5.1',
    })
    await service.startUpdate()

    expect(openPortableDownload).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
