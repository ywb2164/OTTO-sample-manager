import { describe, expect, it, vi } from 'vitest'

import { createElectronDesktopBridge } from './desktopBridge'

describe('createElectronDesktopBridge', () => {
  it('exposes typed namespaces while delegating to the Electron preload API', async () => {
    const api = {
      getOpacity: vi.fn().mockResolvedValue(0.75),
      storeSet: vi.fn().mockResolvedValue(undefined),
      dragOutFiles: vi.fn(),
    } as unknown as Window['electronAPI']

    const bridge = createElectronDesktopBridge(api)

    await expect(bridge.startup.getStatus()).resolves.toEqual({ error: null, writable: true })
    await expect(bridge.window.getOpacity()).resolves.toBe(0.75)
    await bridge.legacyStorage?.set('copySettings', { keepCopies: true })
    await bridge.copySettings.set({ enableAutoCopy: false, keepCopies: true })
    await bridge.drag.start({
      sampleIds: ['one', 'two'],
      filePaths: ['D:\\samples\\one.wav', 'D:\\samples\\two.wav'],
    })

    expect(api.getOpacity).toHaveBeenCalledOnce()
    expect(api.storeSet).toHaveBeenCalledWith('copySettings', { keepCopies: true })
    expect(api.storeSet).toHaveBeenCalledWith('copySettings', {
      enableAutoCopy: false,
      keepCopies: true,
    })
    expect(api.dragOutFiles).toHaveBeenCalledWith([
      'D:\\samples\\one.wav',
      'D:\\samples\\two.wav',
    ])
  })

  it('returns the preload unsubscribe function for update events', () => {
    const unsubscribe = vi.fn()
    const api = {
      onUpdateState: vi.fn().mockReturnValue(unsubscribe),
    } as unknown as Window['electronAPI']
    const listener = vi.fn()

    const bridge = createElectronDesktopBridge(api)
    const returned = bridge.updater.onState(listener)

    expect(returned).toBe(unsubscribe)
    expect(api.onUpdateState).toHaveBeenCalledWith(listener)
  })
})
