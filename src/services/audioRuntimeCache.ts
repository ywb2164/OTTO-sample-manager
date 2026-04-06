type CacheEntry<V> = {
  value: V
  estimatedBytes: number
  lastAccessAt: number
}

export type RuntimeCacheStats = {
  entries: number
  estimatedBytes: number
  hits: number
  misses: number
  evictions: number
  maxBytes: number
}

export type AudioRuntimeCacheStats = {
  audioBuffer: RuntimeCacheStats
  waveform: RuntimeCacheStats
}

const AUDIO_BUFFER_CACHE_LIMIT_BYTES = 200 * 1024 * 1024
const WAVEFORM_CACHE_LIMIT_BYTES = 50 * 1024 * 1024
const isDev = import.meta.env.DEV

class ByteLimitedRuntimeCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>()
  private totalBytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly isProtectedKey?: (key: K) => boolean,
  ) {}

  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }

    this.hits += 1
    entry.lastAccessAt = Date.now()
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  set(key: K, value: V, estimatedBytes: number): void {
    const existing = this.cache.get(key)
    if (existing) {
      this.totalBytes -= existing.estimatedBytes
      this.cache.delete(key)
    }

    this.cache.set(key, {
      value,
      estimatedBytes,
      lastAccessAt: Date.now(),
    })
    this.totalBytes += estimatedBytes

    if (isDev) {
      console.debug(`[cache:${this.name}] set`, {
        key,
        estimatedBytes,
        totalBytes: this.totalBytes,
        entries: this.cache.size,
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

  getStats(): RuntimeCacheStats {
    return {
      entries: this.cache.size,
      estimatedBytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
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
      this.evictions += 1

      if (isDev) {
        console.debug(`[cache:${this.name}] evict`, {
          key,
          freedBytes: entry.estimatedBytes,
          totalBytes: this.totalBytes,
          entries: this.cache.size,
        })
      }
    }
  }
}

const pinnedSampleIds = new Set<string>()
const pendingDecodePromises = new Map<string, Promise<AudioBuffer | null>>()
const pendingWaveformPromises = new Map<string, Promise<Float32Array | null>>()

function isPinnedSample(sampleId: string): boolean {
  return pinnedSampleIds.has(sampleId)
}

function estimateAudioBufferBytes(audioBuffer: AudioBuffer): number {
  return audioBuffer.length * audioBuffer.numberOfChannels * 4
}

const audioBufferCache = new ByteLimitedRuntimeCache<string, AudioBuffer>(
  'audio-buffer',
  AUDIO_BUFFER_CACHE_LIMIT_BYTES,
  isPinnedSample,
)

const waveformCache = new ByteLimitedRuntimeCache<string, Float32Array>(
  'waveform',
  WAVEFORM_CACHE_LIMIT_BYTES,
  isPinnedSample,
)

export const audioRuntimeCache = {
  getAudioBuffer(sampleId: string): AudioBuffer | undefined {
    return audioBufferCache.get(sampleId)
  },

  hasAudioBuffer(sampleId: string): boolean {
    return audioBufferCache.has(sampleId)
  },

  setAudioBuffer(sampleId: string, audioBuffer: AudioBuffer): void {
    audioBufferCache.set(sampleId, audioBuffer, estimateAudioBufferBytes(audioBuffer))
  },

  evictAudioBuffer(sampleId: string): boolean {
    return audioBufferCache.delete(sampleId)
  },

  getWaveform(sampleId: string): Float32Array | undefined {
    return waveformCache.get(sampleId)
  },

  hasWaveform(sampleId: string): boolean {
    return waveformCache.has(sampleId)
  },

  setWaveform(sampleId: string, waveform: Float32Array): void {
    waveformCache.set(sampleId, waveform, waveform.byteLength)
  },

  evictWaveform(sampleId: string): boolean {
    return waveformCache.delete(sampleId)
  },

  pinSample(sampleId: string): void {
    pinnedSampleIds.add(sampleId)
  },

  unpinSample(sampleId: string): void {
    pinnedSampleIds.delete(sampleId)
  },

  getPendingDecode(sampleId: string): Promise<AudioBuffer | null> | undefined {
    return pendingDecodePromises.get(sampleId)
  },

  setPendingDecode(sampleId: string, promise: Promise<AudioBuffer | null>): void {
    pendingDecodePromises.set(sampleId, promise)
  },

  clearPendingDecode(sampleId: string): void {
    pendingDecodePromises.delete(sampleId)
  },

  getPendingWaveform(sampleId: string): Promise<Float32Array | null> | undefined {
    return pendingWaveformPromises.get(sampleId)
  },

  setPendingWaveform(sampleId: string, promise: Promise<Float32Array | null>): void {
    pendingWaveformPromises.set(sampleId, promise)
  },

  clearPendingWaveform(sampleId: string): void {
    pendingWaveformPromises.delete(sampleId)
  },

  clearPending(): void {
    pendingDecodePromises.clear()
    pendingWaveformPromises.clear()
  },

  clearAll(): void {
    audioBufferCache.clear()
    waveformCache.clear()
    this.clearPending()
    pinnedSampleIds.clear()
  },

  getStats(): AudioRuntimeCacheStats {
    return {
      audioBuffer: audioBufferCache.getStats(),
      waveform: waveformCache.getStats(),
    }
  },
}
