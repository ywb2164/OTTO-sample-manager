import { useRef, useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'

// LRU缓存，限制内存中的AudioBuffer数量
class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined
    // 移到末尾（最近使用）
    const value = this.cache.get(key)!
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // 淘汰最久未用（第一个）
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  delete(key: K): void {
    this.cache.delete(key)
  }

  get size(): number {
    return this.cache.size
  }
}

// 波形数据缓存（比AudioBuffer轻很多，可以全量缓存）
const waveformCache = new Map<string, Float32Array>()

// AudioBuffer LRU缓存（最多保留150个已解码的buffer）
const audioBufferCache = new LRUCache<string, AudioBuffer>(150)

// 全局AudioContext（单例）
let audioContextInstance: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContextInstance || audioContextInstance.state === 'closed') {
    audioContextInstance = new AudioContext()
  }
  return audioContextInstance
}

export function useAudioEngine() {
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startTimeRef = useRef<number>(0)       // AudioContext时间戳，播放开始时记录
  const startOffsetRef = useRef<number>(0)     // 从哪个位置开始播放
  const animFrameRef = useRef<number>(0)
  const isPlayingRef = useRef<boolean>(false)

  const { setCurrentTime, setIsPlaying, setDuration, setCurrentSampleId } = usePlayerStore()

  // ------------------------------
  // 解码单个文件
  // ------------------------------
  const decodeFile = useCallback(async (sampleId: string, filePath: string): Promise<AudioBuffer | null> => {
    // 已有缓存直接返回
    if (audioBufferCache.has(sampleId)) {
      return audioBufferCache.get(sampleId)!
    }

    try {
      const ctx = getAudioContext()
      const arrayBuffer = await window.electronAPI.readFileAsBuffer(filePath)
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      audioBufferCache.set(sampleId, audioBuffer)
      return audioBuffer
    } catch (e) {
      console.error(`解码失败: ${filePath}`, e)
      return null
    }
  }, [])

  // ------------------------------
  // 提取波形数据（降采样）
  // ------------------------------
  const extractWaveform = useCallback((sampleId: string, audioBuffer: AudioBuffer): Float32Array => {
    if (waveformCache.has(sampleId)) {
      return waveformCache.get(sampleId)!
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

    waveformCache.set(sampleId, waveform)
    return waveform
  }, [])

  // ------------------------------
  // 批量预解码（后台进行）
  // ------------------------------
  const preDecodeAll = useCallback(async (
    samples: Array<{ id: string; filePath: string }>,
    onProgress?: (decoded: number, total: number) => void
  ) => {
    // 并发数限制为3，避免内存峰值
    const concurrency = 3
    let decoded = 0

    for (let i = 0; i < samples.length; i += concurrency) {
      const batch = samples.slice(i, i + concurrency)
      await Promise.all(
        batch.map(async ({ id, filePath }) => {
          if (!audioBufferCache.has(id)) {
            const buffer = await decodeFile(id, filePath)
            if (buffer) {
              extractWaveform(id, buffer)
            }
          }
          decoded++
          onProgress?.(decoded, samples.length)
        })
      )
    }
  }, [decodeFile, extractWaveform])

  // ------------------------------
  // 播放
  // ------------------------------
  const play = useCallback(async (
    sampleId: string,
    filePath: string,
    offset: number = 0
  ) => {
    // 停止当前播放
    stopPlayback()

    const ctx = getAudioContext()

    // 恢复可能被暂停的AudioContext（浏览器自动策略）
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    // 获取AudioBuffer（可能需要实时解码）
    let buffer = audioBufferCache.get(sampleId) || null
    if (!buffer) {
      buffer = await decodeFile(sampleId, filePath)
      if (!buffer) return
    }

    // 提取波形（如果还没有）
    const waveform = extractWaveform(sampleId, buffer)

    // 创建播放节点
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const safeOffset = Math.max(0, Math.min(offset, buffer.duration))
    source.start(0, safeOffset)

    currentSourceRef.current = source
    startTimeRef.current = ctx.currentTime
    startOffsetRef.current = safeOffset
    isPlayingRef.current = true

    // 更新store状态
    setCurrentSampleId(sampleId)
    setDuration(buffer.duration)
    setIsPlaying(true)

    // 播放结束回调
    source.onended = () => {
      if (isPlayingRef.current) {
        isPlayingRef.current = false
        setIsPlaying(false)
        setCurrentTime(0)
        cancelAnimationFrame(animFrameRef.current)
      }
    }

    // 启动播放位置追踪
    trackPlayhead()

    return waveform
  }, [decodeFile, extractWaveform])

  // ------------------------------
  // 追踪播放进度（requestAnimationFrame）
  // ------------------------------
  const trackPlayhead = useCallback(() => {
    const ctx = getAudioContext()

    const tick = () => {
      if (!isPlayingRef.current) return
      const elapsed = ctx.currentTime - startTimeRef.current
      const currentTime = startOffsetRef.current + elapsed
      setCurrentTime(currentTime)
      animFrameRef.current = requestAnimationFrame(tick)
    }

    animFrameRef.current = requestAnimationFrame(tick)
  }, [setCurrentTime])

  // ------------------------------
  // 停止
  // ------------------------------
  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    isPlayingRef.current = false

    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop()
        currentSourceRef.current.disconnect()
      } catch (e) {
        // 忽略已经停止的source抛出的错误
      }
      currentSourceRef.current = null
    }
    setIsPlaying(false)
  }, [setIsPlaying])

  // ------------------------------
  // 跳转到指定位置
  // ------------------------------
  const seekTo = useCallback((
    sampleId: string,
    filePath: string,
    time: number
  ) => {
    // seek本质是停止当前播放，从新位置重新开始
    const wasPlaying = isPlayingRef.current
    stopPlayback()
    setCurrentTime(time)

    if (wasPlaying) {
      play(sampleId, filePath, time)
    } else {
      // 不播放，只更新位置（用于拖动进度条时预览位置）
      startOffsetRef.current = time
    }
  }, [play, stopPlayback, setCurrentTime])

  // ------------------------------
  // 暂停/恢复
  // ------------------------------
  const togglePause = useCallback(async (
    sampleId: string,
    filePath: string
  ) => {
    if (isPlayingRef.current) {
      // 记录当前时间后停止
      const ctx = getAudioContext()
      const currentTime = startOffsetRef.current + (ctx.currentTime - startTimeRef.current)
      stopPlayback()
      setCurrentTime(currentTime)
      startOffsetRef.current = currentTime
    } else {
      // 从上次停止的位置恢复
      await play(sampleId, filePath, startOffsetRef.current)
    }
  }, [play, stopPlayback, setCurrentTime])

  // 获取缓存的波形数据
  const getWaveform = useCallback((sampleId: string): Float32Array | null => {
    return waveformCache.get(sampleId) ?? null
  }, [])

  return {
    play,
    seekTo,
    togglePause,
    preDecodeAll,
    getWaveform,
  }
}
