export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowSize {
  width?: number
  height?: number
}

export interface WindowBounds extends WorkArea {}

const DEFAULT_WIDTH = 380
const DEFAULT_HEIGHT = 700
const MIN_WIDTH = 300
const MIN_HEIGHT = 500
const MAX_WIDTH = 600

function validDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function calculatePrimarySidebarBounds(
  workArea: WorkArea,
  savedSize: SavedWindowSize,
): WindowBounds {
  const maximumWidth = Math.min(MAX_WIDTH, workArea.width)
  const minimumWidth = Math.min(MIN_WIDTH, maximumWidth)
  const minimumHeight = Math.min(MIN_HEIGHT, workArea.height)
  const width = clamp(validDimension(savedSize.width, DEFAULT_WIDTH), minimumWidth, maximumWidth)
  const height = clamp(validDimension(savedSize.height, DEFAULT_HEIGHT), minimumHeight, workArea.height)

  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height,
  }
}
