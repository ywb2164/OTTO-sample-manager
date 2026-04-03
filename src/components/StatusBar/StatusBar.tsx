import React, { Suspense } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useSampleStore } from '@/store/sampleStore'

interface Props {
  waveformData: Float32Array | null
  onSeek: (time: number) => void
  onTogglePause: () => void
}

const WaveformDisplay = React.lazy(() =>
  import('./WaveformDisplay').then((module) => ({ default: module.WaveformDisplay }))
)

const WaveformPlaceholder: React.FC = () => (
  <div className="w-full h-full bg-gray-800 flex items-center justify-center text-xs text-gray-400">
    无波形数据
  </div>
)

export const StatusBar: React.FC<Props> = ({ waveformData, onSeek, onTogglePause }) => {
  const { currentSampleId, isPlaying, currentTime, duration } = usePlayerStore()
  const { samples } = useSampleStore()

  const currentSample = currentSampleId ? samples.get(currentSampleId) : null

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60)
    const secs = (s % 60).toFixed(2)
    return `${mins}:${secs.padStart(5, '0')}`
  }

  return (
    <div className="flex-shrink-0 border-t border-border bg-bg-secondary">
      {/* 采样信息栏 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border">
        {currentSample ? (
          <>
            <span className="text-xs text-text-primary font-mono font-medium truncate flex-1">
              {currentSample.fileName}{currentSample.fileExt}
            </span>
            <span className="text-xs text-text-dim">
              {currentSample.sampleRate / 1000}kHz
            </span>
            <span className="text-xs text-text-dim">
              {currentSample.channels === 1 ? '单声道' : '立体声'}
            </span>
            <span className="text-xs text-text-dim font-mono">
              {(currentSample.fileSize / 1024).toFixed(1)}KB
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
            ${currentSampleId
              ? 'bg-accent-primary hover:bg-accent-light text-white'
              : 'bg-bg-tertiary text-text-dim cursor-not-allowed'}
          `}
          onClick={onTogglePause}
          disabled={!currentSampleId}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        {/* 时间显示 */}
        <span className="text-xs text-text-dim font-mono">
          {formatTime(currentTime)}
          <span className="text-text-dim opacity-50"> / </span>
          {formatTime(duration)}
        </span>

        {/* 进度条（文字版，视觉补充） */}
        <div className="flex-1 h-1 bg-bg-tertiary rounded-full overflow-hidden">
          <div
            className="h-full bg-accent-primary transition-none rounded-full"
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>
      </div>
    </div>
  )
}
