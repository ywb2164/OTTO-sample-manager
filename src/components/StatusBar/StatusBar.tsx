import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useSampleStore } from '@/store/sampleStore'

interface Props {
  waveformData: Float32Array | null
  onSeek: (time: number) => void
  onPrimaryAction: () => void
  canControl: boolean
  isPrimaryPlaying: boolean
}

const WaveformDisplay = React.lazy(() =>
  import('./WaveformDisplay').then((module) => ({ default: module.WaveformDisplay }))
)

const WaveformPlaceholder: React.FC = () => (
  <div className="w-full h-full bg-gray-800 flex items-center justify-center text-xs text-gray-400">
    无波形数据
  </div>
)

export const StatusBar: React.FC<Props> = ({ waveformData, onSeek, onPrimaryAction, canControl, isPrimaryPlaying }) => {
  const { currentSampleId, isPlaying, currentTime, duration } = usePlayerStore()
  const { samples, selectedIds } = useSampleStore()
  const progressBarRef = useRef<HTMLDivElement>(null)
  const suppressClickRef = useRef(false)
  const [isDraggingProgress, setIsDraggingProgress] = useState(false)
  const [dragPreviewTime, setDragPreviewTime] = useState<number | null>(null)

  const currentSample = currentSampleId ? samples.get(currentSampleId) : null
  const selectedSampleId = selectedIds.values().next().value as string | undefined
  const selectedSample = selectedSampleId ? samples.get(selectedSampleId) ?? null : null
  const displaySample = currentSample ?? selectedSample
  const canSeek = duration > 0 && !!currentSampleId

  const displayedCurrentTime = dragPreviewTime ?? currentTime
  const progressPercentage = useMemo(() => {
    if (duration <= 0) return 0
    return Math.max(0, Math.min(100, (displayedCurrentTime / duration) * 100))
  }, [displayedCurrentTime, duration])

  const getTimeFromClientX = useCallback((clientX: number) => {
    const element = progressBarRef.current
    if (!element || duration <= 0) return null

    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return null

    const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left))
    const ratio = offsetX / rect.width
    return ratio * duration
  }, [duration])

  const commitSeek = useCallback((time: number | null) => {
    if (time === null || duration <= 0 || !currentSampleId) return
    const safeTime = Math.max(0, Math.min(duration, time))
    onSeek(safeTime)
  }, [currentSampleId, duration, onSeek])

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (!canSeek || isDraggingProgress) return
    commitSeek(getTimeFromClientX(e.clientX))
  }, [canSeek, commitSeek, getTimeFromClientX, isDraggingProgress])

  const handleProgressMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSeek) return

    e.preventDefault()
    const initialTime = getTimeFromClientX(e.clientX)
    if (initialTime === null) return

    setIsDraggingProgress(true)
    setDragPreviewTime(initialTime)

    const handleMouseMove = (event: MouseEvent) => {
      setDragPreviewTime(getTimeFromClientX(event.clientX))
    }

    const handleMouseUp = (event: MouseEvent) => {
      const finalTime = getTimeFromClientX(event.clientX)
      suppressClickRef.current = true
      setIsDraggingProgress(false)
      setDragPreviewTime(null)
      commitSeek(finalTime ?? initialTime)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [canSeek, commitSeek, getTimeFromClientX])

  useEffect(() => {
    return () => {
      setIsDraggingProgress(false)
      setDragPreviewTime(null)
    }
  }, [])

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60)
    const secs = (s % 60).toFixed(2)
    return `${mins}:${secs.padStart(5, '0')}`
  }

  const sampleRateLabel = displaySample && displaySample.sampleRate > 0
    ? `${displaySample.sampleRate / 1000}kHz`
    : '--'
  /*
  const channelLabel = displaySample && displaySample.channels > 0
    ? (displaySample.channels === 1 ? '鍗曞０閬? : '绔嬩綋澹?')
    : '--'
  */
  const channelLabel = displaySample && displaySample.channels > 0
    ? (displaySample.channels === 1 ? 'Mono' : 'Stereo')
    : '--'

  return (
    <div className="flex-shrink-0 border-t border-border bg-bg-secondary">
      {/* 采样信息栏 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border">
        {displaySample ? (
          <>
            <span className="text-xs text-text-primary font-mono font-medium truncate flex-1">
              {displaySample.fileName}{displaySample.fileExt}
            </span>
            {/*<span className="text-xs text-text-dim">
              {sampleRateLabel}
            </span>
            <span className="text-xs text-text-dim">
              {channelLabel}
            </span>
            <span className="text-xs text-text-dim">
              {displaySample.channels === 1 ? '单声道' : '立体声'}
            </span>
            */}
            <span className="text-xs text-text-dim">
              {sampleRateLabel}
            </span>
            <span className="text-xs text-text-dim">
              {channelLabel}
            </span>
            <span className="text-xs text-text-dim font-mono">
              {(displaySample.fileSize / 1024).toFixed(1)}KB
            </span>
          </>
        ) : (
          <span className="text-xs text-text-dim">未选择采样</span>
        )}
      </div>

      {/* 波形区域 */}
      <div className="h-20 relative">
        {waveformData && waveformData.length > 0 ? (
          <Suspense fallback={<WaveformPlaceholder />}>
            <WaveformDisplay
              waveformData={waveformData}
              duration={duration}
              onSeek={onSeek}
            />
          </Suspense>
        ) : (
          <WaveformPlaceholder />
        )}
      </div>

      {/* 播放控制栏 */}
      <div className="flex items-center gap-3 px-3 py-1.5">
        {/* 播放/暂停按钮 */}
        <button
          className={`
            w-7 h-7 rounded-full flex items-center justify-center
            transition-colors text-sm
            ${canControl
              ? 'bg-accent-primary hover:bg-accent-light text-white'
              : 'bg-bg-tertiary text-text-dim cursor-not-allowed'}
          `}
          onClick={onPrimaryAction}
          disabled={!canControl}
        >
          {isPrimaryPlaying ? '⏸' : '▶'}
        </button>

        {/* 时间显示 */}
        <span className="text-xs text-text-dim font-mono">
          {formatTime(displayedCurrentTime)}
          <span className="text-text-dim opacity-50"> / </span>
          {formatTime(duration)}
        </span>

        {/* 进度条 */}
        <div
          ref={progressBarRef}
          className={`flex-1 relative h-5 flex items-center ${canSeek ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
          onClick={handleProgressClick}
          onMouseDown={handleProgressMouseDown}
          aria-disabled={!canSeek}
        >
          <div className="w-full h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-primary transition-none rounded-full"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-sm border border-accent-primary pointer-events-none"
            style={{ left: `calc(${progressPercentage}% - 6px)` }}
          />
        </div>
      </div>
    </div>
  )
}
