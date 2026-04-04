import { useRef, useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'

const AUDIO_BUFFER_CACHE_LIMIT_BYTES = 200 * 1024 * 1024
const WAVEFORM_CACHE_LIMIT_BYTES = 50 * 1024 * 1024
const isDev = import.meta.env.DEV
let isShuttingDown = false
let shutdownSummaryLogged = false

type CacheEntry<V> = {
  value: V
  estimatedBytes: number
  lastAccessAt: number
}

class ByteLimitedLRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>()
  private totalBytes = 0

  constructor(
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly isProtectedKey?: (key: K) => boolean,
  ) {}

  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    entry.lastAccessAt = Date.now()
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  set(key: K, value: V, estimatedBytes: number): void {
    const now = Date.now()
    const existing = this.cache.get(key)
    if (existing) {
      this.totalBytes -= existing.estimatedBytes
      this.cache.delete(key)
    }

    this.cache.set(key, {
      value,
      estimatedBytes,
      lastAccessAt: now,
    })
    this.totalBytes += estimatedBytes

    if (isDev && !isShuttingDown) {
      console.debug(`[cache:${this.name}] set`, {
        key,
        estimatedBytes,
        totalBytes: this.totalBytes,
        count: this.cache.size,
      })
    }

    this.evictIfNeeded()
  }

  delete(key: K): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false

    this.totalBytes -= entry.estimatedBytes
    this.cache.delete(key)
    return true
  }

  clear(): void {
    this.cache.clear()
    this.totalBytes = 0
  }

  getStats() {
    return {
      count: this.cache.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
    }
  }

  private evictIfNeeded(): void {
    if (this.totalBytes <= this.maxBytes) return

    const candidates = [...this.cache.entries()]
      .filter(([key]) => !this.isProtectedKey?.(key))
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)

    for (const [key, entry] of candidates) {
      if (this.totalBytes <= this.maxBytes) break

      this.cache.delete(key)
      this.totalBytes -= entry.estimatedBytes

      if (isDev && !isShuttingDown) {
        console.debug(`[cache:${this.name}] evict`, {
          key,
          freedBytes: entry.estimatedBytes,
          totalBytes: this.totalBytes,
          count: this.cache.size,
        })
      }
    }
  }
}

const pinnedSampleIds = new Set<string>()

function isPinnedSample(sampleId: string): boolean {
  return pinnedSampleIds.has(sampleId)
}

// 波形数据缓存
const waveformCache = new ByteLimitedLRUCache<string, Float32Array>(
  'waveform',
  WAVEFORM_CACHE_LIMIT_BYTES,
  isPinnedSample,
)

// AudioBuffer LRU缓存
const audioBufferCache = new ByteLimitedLRUCache<string, AudioBuffer>(
  'audio-buffer',
  AUDIO_BUFFER_CACHE_LIMIT_BYTES,
  isPinnedSample,
)

// 全局AudioContext（单例）
let audioContextInstance: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContextInstance || audioContextInstance.state === 'closed') {
    audioContextInstance = new AudioContext()
  }
  return audioContextInstance
}

function estimateAudioBufferBytes(audioBuffer: AudioBuffer): number {
  return audioBuffer.length * audioBuffer.numberOfChannels * 4
}

function cacheAudioBuffer(sampleId: string, audioBuffer: AudioBuffer): void {
  audioBufferCache.set(sampleId, audioBuffer, estimateAudioBufferBytes(audioBuffer))
}

function cacheWaveform(sampleId: string, waveform: Float32Array): void {
  waveformCache.set(sampleId, waveform, waveform.byteLength)
}

function getCacheStatsSnapshot() {
  return {
    audioBufferCacheCount: audioBufferCache.getStats().count,
    audioBufferCacheBytes: audioBufferCache.getStats().bytes,
    waveformCacheCount: waveformCache.getStats().count,
    waveformCacheBytes: waveformCache.getStats().bytes,
  }
}

export function useAudioEngine() {
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startTimeRef = useRef<number>(0)
  const startOffsetRef = useRef<number>(0)
  const animFrameRef = useRef<number>(0)
  const isPlayingRef = useRef<boolean>(false)

  const { setCurrentTime, setIsPlaying, setDuration, setCurrentSampleId, setCurrentFilePath } = usePlayerStore()

  const decodeFile = useCallback(async (sampleId: string, filePath: string): Promise<AudioBuffer | null> => {
    if (isShuttingDown) {
      return null
    }

    const cached = audioBufferCache.get(sampleId)
    if (cached) {
      return cached
    }

    try {
      const ctx = getAudioContext()
      const arrayBuffer = await window.electronAPI.readFileAsBuffer(filePath)
      if (isShuttingDown) {
        return null
      }
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      if (isShuttingDown) {
        return null
      }
      cacheAudioBuffer(sampleId, audioBuffer)
      return audioBuffer
    } catch (e) {
      console.error(`解码失败: ${filePath}`, e)
      return null
    }
  }, [])

  const extractWaveform = useCallback((sampleId: string, audioBuffer: AudioBuffer): Float32Array => {
    const cached = waveformCache.get(sampleId)
    if (cached) {
      return cached
    }

    if (isShuttingDown) {
      return new Float32Array(0)
    }

    const targetPoints = 2400
    const channelData = audioBuffer.getChannelData(0)
    const blockSize = Math.max(1, Math.floor(channelData.length / targetPoints))
    const waveform = new Float32Array(targetPoints)

    for (let i = 0; i < targetPoints; i++) {
      let max = 0
      const start = i * blockSize
      const end = Math.min(start + blockSize, channelData.length)
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j])
        if (abs > max) max = abs
      }
      waveform[i] = max
    }

    cacheWaveform(sampleId, waveform)
    return waveform
  }, [])

  const primeDecodedSample = useCallback((sampleId: string, audioBuffer: AudioBuffer): Float32Array => {
    if (isShuttingDown) {
      return new Float32Array(0)
    }
    cacheAudioBuffer(sampleId, audioBuffer)
    return extractWaveform(sampleId, audioBuffer)
  }, [extractWaveform])

  const preDecodeAll = useCallback(async (
    samples: Array<{ id: string; filePath: string }>,
    onProgress?: (decoded: number, total: number) => void
  ) => {
    if (isShuttingDown) {
      return
    }

    const concurrency = 3
    let decoded = 0

    for (let i = 0; i < samples.length; i += concurrency) {
      if (isShuttingDown) {
        return
      }

      const batch = samples.slice(i, i + concurrency)
      await Promise.all(
        batch.map(async ({ id, filePath }) => {
          if (isShuttingDown) {
            return
          }

          let buffer = audioBufferCache.get(id)
          if (!buffer) {
            buffer = await decodeFile(id, filePath)
          }

          if (buffer && !waveformCache.has(id) && !isShuttingDown) {
            extractWaveform(id, buffer)
          }

          if (isShuttingDown) {
            return
          }

          decoded++
          onProgress?.(decoded, samples.length)
        })
      )
    }
  }, [decodeFile, extractWaveform])

  const play = useCallback(async (
    sampleId: string,
    filePath: string,
    offset: number = 0
  ) => {
    if (isShuttingDown) {
      return null
    }

    stopPlayback()

    const ctx = getAudioContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    let buffer = audioBufferCache.get(sampleId) || null
    if (!buffer) {
      buffer = await decodeFile(sampleId, filePath)
      if (!buffer) return
    }

    const waveform = extractWaveform(sampleId, buffer)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const safeOffset = Math.max(0, Math.min(offset, buffer.duration))
    source.start(0, safeOffset)

    currentSourceRef.current = source
    startTimeRef.current = ctx.currentTime
    startOffsetRef.current = safeOffset
    isPlayingRef.current = true
    pinnedSampleIds.add(sampleId)

    setCurrentSampleId(sampleId)
    setCurrentFilePath(filePath)
    setDuration(buffer.duration)
    setIsPlaying(true)

    source.onended = () => {
      if (isPlayingRef.current) {
        isPlayingRef.current = false
        pinnedSampleIds.delete(sampleId)
        setIsPlaying(false)
        setCurrentTime(0)
        cancelAnimationFrame(animFrameRef.current)
      }
    }

    trackPlayhead()

    return waveform
  }, [decodeFile, extractWaveform])

  const trackPlayhead = useCallback(() => {
    const ctx = getAudioContext()

    const tick = () => {
      if (!isPlayingRef.current || isShuttingDown) return
      const elapsed = ctx.currentTime - startTimeRef.current
      const currentTime = startOffsetRef.current + elapsed
      setCurrentTime(currentTime)
      animFrameRef.current = requestAnimationFrame(tick)
    }

    animFrameRef.current = requestAnimationFrame(tick)
  }, [setCurrentTime])

  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    isPlayingRef.current = false

    const currentSampleId = usePlayerStore.getState().currentSampleId
    if (currentSampleId) {
      pinnedSampleIds.delete(currentSampleId)
    }

    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop()
        currentSourceRef.current.disconnect()
      } catch {
        // ignore
      }
      currentSourceRef.current = null
    }
    setIsPlaying(false)
  }, [setIsPlaying])

  const seekTo = useCallback((
    sampleId: string,
    filePath: string,
    time: number
  ) => {
    const wasPlaying = isPlayingRef.current
    stopPlayback()
    setCurrentTime(time)

    if (wasPlaying) {
      play(sampleId, filePath, time)
    } else {
      startOffsetRef.current = time
    }
  }, [play, stopPlayback, setCurrentTime])

  const togglePause = useCallback(async (
    sampleId: string,
    filePath: string
  ) => {
    if (isShuttingDown) {
      return
    }

    if (isPlayingRef.current) {
      const ctx = getAudioContext()
      const currentTime = startOffsetRef.current + (ctx.currentTime - startTimeRef.current)
      stopPlayback()
      setCurrentTime(currentTime)
      startOffsetRef.current = currentTime
    } else {
      await play(sampleId, filePath, startOffsetRef.current)
    }
  }, [play, stopPlayback, setCurrentTime])

  const getWaveform = useCallback((sampleId: string): Float32Array | null => {
    return waveformCache.get(sampleId) ?? null
  }, [])

  const getCacheStats = useCallback(() => ({
    ...getCacheStatsSnapshot(),
  }), [])

  const beginShutdown = useCallback(() => {
    if (isShuttingDown) {
      return
    }

    isShuttingDown = true

    if (isDev && !shutdownSummaryLogged) {
      shutdownSummaryLogged = true
      console.debug('[shutdown] stopping audio engine', getCacheStatsSnapshot())
    }

    stopPlayback()
  }, [stopPlayback])

  return {
    play,
    seekTo,
    togglePause,
    preDecodeAll,
    getWaveform,
    primeDecodedSample,
    getCacheStats,
    beginShutdown,
  }
}
