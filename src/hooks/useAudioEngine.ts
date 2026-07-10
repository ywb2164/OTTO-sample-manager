import { useRef, useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useSampleStore } from '@/store/sampleStore'
import { audioRuntimeCache } from '@/services/audioRuntimeCache'

const isDev = import.meta.env.DEV
let isShuttingDown = false
let shutdownSummaryLogged = false

// 全局AudioContext（单例）
let audioContextInstance: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContextInstance || audioContextInstance.state === 'closed') {
    audioContextInstance = new AudioContext()
  }
  return audioContextInstance
}

function getCacheStatsSnapshot() {
  return audioRuntimeCache.getStats()
}

export function useAudioEngine() {
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startTimeRef = useRef<number>(0)
  const startOffsetRef = useRef<number>(0)
  const animFrameRef = useRef<number>(0)
  const isPlayingRef = useRef<boolean>(false)
  const playbackRequestIdRef = useRef<number>(0)

  const { setCurrentTime, setIsPlaying, setDuration, setCurrentSampleId, setCurrentFilePath } = usePlayerStore()

  const decodeFile = useCallback(async (sampleId: string, filePath: string): Promise<AudioBuffer | null> => {
    if (isShuttingDown) {
      return null
    }

    const cached = audioRuntimeCache.getAudioBuffer(sampleId)
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
      audioRuntimeCache.setAudioBuffer(sampleId, audioBuffer)
      useSampleStore.getState().updateSample(sampleId, {
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels,
        isDecoded: true,
      })
      return audioBuffer
    } catch (e) {
      console.error(`解码失败: ${filePath}`, e)
      return null
    }
  }, [])

  const extractWaveform = useCallback((sampleId: string, audioBuffer: AudioBuffer): Float32Array => {
    const cached = audioRuntimeCache.getWaveform(sampleId)
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

    audioRuntimeCache.setWaveform(sampleId, waveform)
    return waveform
  }, [])

  const ensureDecodedSample = useCallback(async (
    sampleId: string,
    filePath: string
  ): Promise<AudioBuffer | null> => {
    if (isShuttingDown) {
      return null
    }

    const cached = audioRuntimeCache.getAudioBuffer(sampleId)
    if (cached) {
      return cached
    }

    const pending = audioRuntimeCache.getPendingDecode(sampleId)
    if (pending) {
      return pending
    }

    const decodePromise = decodeFile(sampleId, filePath).finally(() => {
      audioRuntimeCache.clearPendingDecode(sampleId)
    })

    audioRuntimeCache.setPendingDecode(sampleId, decodePromise)
    return decodePromise
  }, [decodeFile])

  const ensureWaveformReady = useCallback(async (
    sampleId: string,
    filePath: string
  ): Promise<Float32Array | null> => {
    if (isShuttingDown) {
      return null
    }

    const cached = audioRuntimeCache.getWaveform(sampleId)
    if (cached) {
      return cached
    }

    const pending = audioRuntimeCache.getPendingWaveform(sampleId)
    if (pending) {
      return pending
    }

    const waveformPromise = ensureDecodedSample(sampleId, filePath)
      .then((audioBuffer) => {
        if (!audioBuffer || isShuttingDown) {
          return null
        }

        return extractWaveform(sampleId, audioBuffer)
      })
      .finally(() => {
        audioRuntimeCache.clearPendingWaveform(sampleId)
      })

    audioRuntimeCache.setPendingWaveform(sampleId, waveformPromise)
    return waveformPromise
  }, [ensureDecodedSample, extractWaveform])

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

  const stopPlayback = useCallback((options?: { resetTime?: boolean; clearSample?: boolean }) => {
    playbackRequestIdRef.current += 1
    cancelAnimationFrame(animFrameRef.current)
    isPlayingRef.current = false

    const currentSampleId = usePlayerStore.getState().currentSampleId
    if (currentSampleId) {
      audioRuntimeCache.unpinSample(currentSampleId)
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
    if (options?.resetTime) {
      setCurrentTime(0)
    }
    if (options?.clearSample) {
      setCurrentSampleId(null)
      setCurrentFilePath(null)
      setDuration(0)
    }
  }, [setCurrentFilePath, setCurrentSampleId, setCurrentTime, setDuration, setIsPlaying])

  const play = useCallback(async (
    sampleId: string,
    filePath: string,
    offset: number = 0
  ) => {
    if (isShuttingDown) {
      return null
    }

    stopPlayback()
    const requestId = playbackRequestIdRef.current

    const ctx = getAudioContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    if (playbackRequestIdRef.current !== requestId || isShuttingDown) {
      return null
    }

    const buffer = await ensureDecodedSample(sampleId, filePath)
    if (!buffer || playbackRequestIdRef.current !== requestId || isShuttingDown) {
      if (playbackRequestIdRef.current === requestId) {
        stopPlayback({ resetTime: true, clearSample: true })
      }
      return null
    }

    const waveform = await ensureWaveformReady(sampleId, filePath)
    if (playbackRequestIdRef.current !== requestId || isShuttingDown) {
      return null
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const safeOffset = Math.max(0, Math.min(offset, buffer.duration))
    source.start(0, safeOffset)

    currentSourceRef.current = source
    startTimeRef.current = ctx.currentTime
    startOffsetRef.current = safeOffset
    isPlayingRef.current = true
    audioRuntimeCache.pinSample(sampleId)

    setCurrentSampleId(sampleId)
    setCurrentFilePath(filePath)
    setDuration(buffer.duration)
    setIsPlaying(true)

    source.onended = () => {
      if (currentSourceRef.current !== source || !isPlayingRef.current) {
        return
      }

      isPlayingRef.current = false
      currentSourceRef.current = null
      audioRuntimeCache.unpinSample(sampleId)
      setIsPlaying(false)
      setCurrentTime(0)
      cancelAnimationFrame(animFrameRef.current)
    }

    trackPlayhead()

    return waveform ?? null
  }, [ensureDecodedSample, ensureWaveformReady, setCurrentFilePath, setCurrentSampleId, setCurrentTime, setDuration, setIsPlaying, stopPlayback, trackPlayhead])

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
    return audioRuntimeCache.getWaveform(sampleId) ?? null
  }, [])

  const getCacheStats = useCallback(() => audioRuntimeCache.getStats(), [])

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
    audioRuntimeCache.clearPending()
  }, [stopPlayback])

  return {
    ensureDecodedSample,
    ensureWaveformReady,
    play,
    seekTo,
    stopPlayback,
    togglePause,
    getWaveform,
    getCacheStats,
    beginShutdown,
  }
}
