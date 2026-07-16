import { useRef, useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useSampleStore } from '@/store/sampleStore'
import { audioRuntimeCache } from '@/services/audioRuntimeCache'
import { getDesktopBridge } from '@/services/desktopBridge'

const isDev = import.meta.env.DEV
const STREAMING_FILE_SIZE_THRESHOLD = 32 * 1024 * 1024
const STREAMING_DURATION_THRESHOLD_SECONDS = 5 * 60
const PLAYHEAD_INTERVAL_MS = 50
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

function publishWaveform(sampleId: string, waveform: Float32Array): void {
  window.dispatchEvent(new CustomEvent('otto:waveform-ready', {
    detail: { sampleId, waveform },
  }))
}

export function useAudioEngine() {
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const currentMediaRef = useRef<HTMLAudioElement | null>(null)
  const startTimeRef = useRef<number>(0)
  const startOffsetRef = useRef<number>(0)
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isPlayingRef = useRef<boolean>(false)
  const playbackRequestIdRef = useRef<number>(0)
  const pendingReadAbortRef = useRef<AbortController | null>(null)
  const pendingReadSampleIdRef = useRef<string | null>(null)

  const setCurrentTime = usePlayerStore((state) => state.setCurrentTime)
  const setIsPlaying = usePlayerStore((state) => state.setIsPlaying)
  const setDuration = usePlayerStore((state) => state.setDuration)
  const setCurrentSampleId = usePlayerStore((state) => state.setCurrentSampleId)
  const setCurrentFilePath = usePlayerStore((state) => state.setCurrentFilePath)

  const decodeFile = useCallback(async (sampleId: string, filePath: string): Promise<AudioBuffer | null> => {
    if (isShuttingDown) {
      return null
    }

    const cached = audioRuntimeCache.getAudioBuffer(sampleId)
    if (cached) {
      return cached
    }

    let readAbortController: AbortController | null = null
    try {
      const ctx = getAudioContext()
      const desktop = getDesktopBridge()
      readAbortController = desktop.runtime === 'tauri' ? new AbortController() : null
      const previousPendingSampleId = pendingReadSampleIdRef.current
      pendingReadAbortRef.current?.abort()
      if (previousPendingSampleId) audioRuntimeCache.clearPendingDecode(previousPendingSampleId)
      pendingReadAbortRef.current = readAbortController
      pendingReadSampleIdRef.current = readAbortController ? sampleId : null
      const arrayBuffer = desktop.runtime === 'tauri'
        ? await desktop.audio.readSampleBytes(sampleId, readAbortController?.signal)
        : await desktop.files.readAsBuffer(filePath)
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
      if (e instanceof DOMException && e.name === 'AbortError') return null
      console.error(`解码失败: ${filePath}`, e)
      return null
    } finally {
      if (pendingReadAbortRef.current === readAbortController) {
        pendingReadAbortRef.current = null
        pendingReadSampleIdRef.current = null
      }
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
    publishWaveform(sampleId, waveform)
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

    let decodePromise: Promise<AudioBuffer | null>
    decodePromise = decodeFile(sampleId, filePath).finally(() => {
      audioRuntimeCache.clearPendingDecode(sampleId, decodePromise)
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

    let waveformPromise: Promise<Float32Array | null>
    waveformPromise = ensureDecodedSample(sampleId, filePath)
      .then((audioBuffer) => {
        if (!audioBuffer || isShuttingDown) {
          return null
        }

        return extractWaveform(sampleId, audioBuffer)
      })
      .finally(() => {
        audioRuntimeCache.clearPendingWaveform(sampleId, waveformPromise)
      })

    audioRuntimeCache.setPendingWaveform(sampleId, waveformPromise)
    return waveformPromise
  }, [ensureDecodedSample, extractWaveform])

  const trackPlayhead = useCallback((mode: 'buffer' | 'stream') => {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current)
    progressTimerRef.current = setInterval(() => {
      if (!isPlayingRef.current || isShuttingDown) return
      if (mode === 'stream') {
        const media = currentMediaRef.current
        if (media) setCurrentTime(media.currentTime)
        return
      }
      const ctx = getAudioContext()
      const elapsed = ctx.currentTime - startTimeRef.current
      setCurrentTime(startOffsetRef.current + elapsed)
    }, PLAYHEAD_INTERVAL_MS)
  }, [setCurrentTime])

  const stopPlayback = useCallback((options?: { resetTime?: boolean; clearSample?: boolean }) => {
    playbackRequestIdRef.current += 1
    const pendingReadSampleId = pendingReadSampleIdRef.current
    pendingReadAbortRef.current?.abort()
    pendingReadAbortRef.current = null
    pendingReadSampleIdRef.current = null
    if (pendingReadSampleId) audioRuntimeCache.clearPendingDecode(pendingReadSampleId)
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current)
      progressTimerRef.current = null
    }
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
    if (currentMediaRef.current) {
      currentMediaRef.current.pause()
      currentMediaRef.current.removeAttribute('src')
      currentMediaRef.current.load()
      currentMediaRef.current = null
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
    const desktop = getDesktopBridge()
    const sample = useSampleStore.getState().samples.get(sampleId)
    const shouldStream = desktop.runtime === 'tauri' && Boolean(sample && (
      sample.fileSize > STREAMING_FILE_SIZE_THRESHOLD ||
      sample.duration > STREAMING_DURATION_THRESHOLD_SECONDS
    ))

    if (shouldStream) {
      try {
        const streamUrl = await desktop.audio.getStreamUrl(sampleId)
        if (playbackRequestIdRef.current !== requestId || isShuttingDown) return null
        const media = new Audio(streamUrl)
        media.preload = 'metadata'
        media.onloadedmetadata = () => {
          if (currentMediaRef.current !== media) return
          const safeOffset = Math.max(0, Math.min(offset, media.duration || offset))
          media.currentTime = safeOffset
          startOffsetRef.current = safeOffset
          if (Number.isFinite(media.duration)) setDuration(media.duration)
        }
        media.onended = () => {
          if (currentMediaRef.current !== media) return
          isPlayingRef.current = false
          setIsPlaying(false)
          setCurrentTime(0)
          if (progressTimerRef.current) clearInterval(progressTimerRef.current)
          progressTimerRef.current = null
        }
        currentMediaRef.current = media
        setCurrentSampleId(sampleId)
        setCurrentFilePath(filePath)
        setDuration(sample?.duration ?? 0)
        await media.play()
        if (playbackRequestIdRef.current !== requestId || isShuttingDown) {
          media.pause()
          return null
        }
        isPlayingRef.current = true
        setIsPlaying(true)
        trackPlayhead('stream')
        void desktop.audio.getWaveform(sampleId).then(({ mins, maxs }) => {
          const length = Math.min(mins.length, maxs.length)
          const waveform = new Float32Array(length)
          for (let index = 0; index < length; index++) {
            waveform[index] = Math.max(Math.abs(mins[index]), Math.abs(maxs[index]))
          }
          audioRuntimeCache.setWaveform(sampleId, waveform)
          publishWaveform(sampleId, waveform)
        }).catch((error) => {
          console.warn(`波形生成失败: ${filePath}`, error)
        })
        return audioRuntimeCache.getWaveform(sampleId) ?? null
      } catch (error) {
        console.error(`流式播放失败: ${filePath}`, error)
        if (playbackRequestIdRef.current === requestId) {
          stopPlayback({ resetTime: true, clearSample: true })
        }
        return null
      }
    }

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
      if (progressTimerRef.current) clearInterval(progressTimerRef.current)
      progressTimerRef.current = null
    }

    trackPlayhead('buffer')
    void ensureWaveformReady(sampleId, filePath).then((waveform) => {
      if (!waveform || playbackRequestIdRef.current !== requestId) return
      publishWaveform(sampleId, waveform)
    })

    return audioRuntimeCache.getWaveform(sampleId) ?? null
  }, [ensureDecodedSample, ensureWaveformReady, setCurrentFilePath, setCurrentSampleId, setCurrentTime, setDuration, setIsPlaying, stopPlayback, trackPlayhead])

  const seekTo = useCallback((
    sampleId: string,
    filePath: string,
    time: number
  ) => {
    if (currentMediaRef.current) {
      currentMediaRef.current.currentTime = Math.max(0, time)
      startOffsetRef.current = Math.max(0, time)
      setCurrentTime(time)
      return
    }
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
      if (currentMediaRef.current) {
        currentMediaRef.current.pause()
        isPlayingRef.current = false
        setIsPlaying(false)
        setCurrentTime(currentMediaRef.current.currentTime)
        startOffsetRef.current = currentMediaRef.current.currentTime
        return
      }
      const ctx = getAudioContext()
      const currentTime = startOffsetRef.current + (ctx.currentTime - startTimeRef.current)
      stopPlayback()
      setCurrentTime(currentTime)
      startOffsetRef.current = currentTime
    } else {
      if (currentMediaRef.current) {
        await currentMediaRef.current.play()
        isPlayingRef.current = true
        setIsPlaying(true)
        trackPlayhead('stream')
        return
      }
      await play(sampleId, filePath, startOffsetRef.current)
    }
  }, [play, setIsPlaying, stopPlayback, setCurrentTime, trackPlayhead])

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
