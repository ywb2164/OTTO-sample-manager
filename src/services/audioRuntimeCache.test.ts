import { afterEach, describe, expect, it } from 'vitest'
import { audioRuntimeCache } from './audioRuntimeCache'

function audioBufferWithBytes(bytes: number): AudioBuffer {
  return {
    length: bytes / 4,
    numberOfChannels: 1,
  } as AudioBuffer
}

describe('audioRuntimeCache', () => {
  afterEach(() => {
    audioRuntimeCache.clearAll()
    audioRuntimeCache.setMemoryOptimizationMode(false)
  })

  it('uses the existing default budgets and lower budgets in memory optimization mode', () => {
    expect(audioRuntimeCache.getStats()).toMatchObject({
      audioBuffer: { maxBytes: 200 * 1024 * 1024 },
      waveform: { maxBytes: 50 * 1024 * 1024 },
    })

    audioRuntimeCache.setMemoryOptimizationMode(true)
    expect(audioRuntimeCache.getStats()).toMatchObject({
      audioBuffer: { maxBytes: 64 * 1024 * 1024 },
      waveform: { maxBytes: 8 * 1024 * 1024 },
    })
  })

  it('immediately evicts to a lowered budget, but keeps the pinned playing sample until unpinned', () => {
    audioRuntimeCache.setAudioBuffer('old', audioBufferWithBytes(48 * 1024 * 1024))
    audioRuntimeCache.pinSample('playing')
    audioRuntimeCache.setAudioBuffer('playing', audioBufferWithBytes(80 * 1024 * 1024))

    audioRuntimeCache.setMemoryOptimizationMode(true)
    expect(audioRuntimeCache.hasAudioBuffer('playing')).toBe(true)
    expect(audioRuntimeCache.getStats().audioBuffer.estimatedBytes).toBeGreaterThan(64 * 1024 * 1024)

    audioRuntimeCache.unpinSample('playing')
    expect(audioRuntimeCache.getStats().audioBuffer.estimatedBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  it('removes decoded, waveform, pending, and pin state for deleted samples', () => {
    audioRuntimeCache.setAudioBuffer('deleted', audioBufferWithBytes(1024))
    audioRuntimeCache.setWaveform('deleted', new Float32Array(32))
    audioRuntimeCache.pinSample('deleted')
    audioRuntimeCache.setPendingDecode('deleted', Promise.resolve(null))
    audioRuntimeCache.setPendingWaveform('deleted', Promise.resolve(null))

    audioRuntimeCache.removeSample('deleted')

    expect(audioRuntimeCache.hasAudioBuffer('deleted')).toBe(false)
    expect(audioRuntimeCache.hasWaveform('deleted')).toBe(false)
    expect(audioRuntimeCache.getPendingDecode('deleted')).toBeUndefined()
    expect(audioRuntimeCache.getPendingWaveform('deleted')).toBeUndefined()
  })
})
