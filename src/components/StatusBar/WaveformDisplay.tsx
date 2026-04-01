import React, { useRef, useEffect, useState } from 'react'

interface Props {
  waveformData: Float32Array | null
  duration: number
  onSeek: (time: number) => void
}

export const WaveformDisplay: React.FC<Props> = ({ waveformData, duration, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

  // 监听容器大小变化
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateDimensions = () => {
      const { width, height } = container.getBoundingClientRect()
      setDimensions({ width, height })
    }

    updateDimensions()
    const resizeObserver = new ResizeObserver(updateDimensions)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  // 绘制波形
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !waveformData || dimensions.width === 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 设置Canvas大小
    canvas.width = dimensions.width * window.devicePixelRatio
    canvas.height = dimensions.height * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    // 清除画布
    ctx.clearRect(0, 0, dimensions.width, dimensions.height)

    // 设置样式
    const waveformColor = '#4f46e5' // indigo-600
    const backgroundColor = '#1f2937' // gray-800
    const centerLineColor = '#4b5563' // gray-600

    // 绘制背景
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, dimensions.width, dimensions.height)

    // 绘制中心线
    ctx.beginPath()
    ctx.moveTo(0, dimensions.height / 2)
    ctx.lineTo(dimensions.width, dimensions.height / 2)
    ctx.strokeStyle = centerLineColor
    ctx.lineWidth = 0.5
    ctx.stroke()

    // 绘制波形
    if (waveformData.length > 0) {
      const data = waveformData
      const step = Math.max(1, Math.floor(data.length / dimensions.width))
      const pointsPerPixel = Math.ceil(data.length / dimensions.width)

      ctx.beginPath()

      for (let x = 0; x < dimensions.width; x++) {
        const startIdx = Math.floor(x * pointsPerPixel)
        const endIdx = Math.min(startIdx + step, data.length)

        let max = 0
        for (let i = startIdx; i < endIdx; i++) {
          max = Math.max(max, Math.abs(data[i]))
        }

        const y = (1 - max) * dimensions.height / 2

        if (x === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }

        // 对称绘制下半部分
        if (x === 0) {
          ctx.moveTo(x, dimensions.height - y)
        } else {
          ctx.lineTo(x, dimensions.height - y)
        }
      }

      ctx.closePath()

      // 创建渐变填充
      const gradient = ctx.createLinearGradient(0, 0, 0, dimensions.height)
      gradient.addColorStop(0, waveformColor)
      gradient.addColorStop(0.5, '#7c3aed') // indigo-500
      gradient.addColorStop(1, waveformColor)

      ctx.fillStyle = gradient
      ctx.fill()

      // 绘制波形轮廓
      ctx.strokeStyle = '#818cf8' // indigo-400
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // 绘制"无波形数据"提示
    if (waveformData.length === 0) {
      ctx.fillStyle = '#9ca3af'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('No Waveform Data', dimensions.width / 2, dimensions.height / 2)
    }
  }, [waveformData, dimensions])

  // 处理点击跳转
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration || duration <= 0) return

    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * duration

    onSeek(time)
  }

  if (!waveformData || waveformData.length === 0) {
    return (
      <div ref={containerRef} className="w-full h-full bg-gray-800 flex items-center justify-center text-xs text-gray-400">
        无波形数据
      </div>
    )
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-pointer"
        onClick={handleClick}
        style={{ display: 'block' }}
      />
    </div>
  )
}
