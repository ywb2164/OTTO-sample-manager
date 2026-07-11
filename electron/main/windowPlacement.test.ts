import { describe, expect, it } from 'vitest'
import { calculatePrimarySidebarBounds } from './windowPlacement'

describe('calculatePrimarySidebarBounds', () => {
  it('places the saved 600x752 window at 680,0 on the current 1280x752 work area', () => {
    expect(calculatePrimarySidebarBounds(
      { x: 0, y: 0, width: 1280, height: 752 },
      { width: 600, height: 752 },
    )).toEqual({ x: 680, y: 0, width: 600, height: 752 })
  })

  it('clamps oversized saved dimensions to application and work-area limits', () => {
    expect(calculatePrimarySidebarBounds(
      { x: 0, y: 0, width: 1280, height: 752 },
      { width: 2000, height: 1200 },
    )).toEqual({ x: 680, y: 0, width: 600, height: 752 })
  })

  it('respects a primary display with a negative origin', () => {
    expect(calculatePrimarySidebarBounds(
      { x: -1024, y: 20, width: 1024, height: 700 },
      { width: 380, height: 500 },
    )).toEqual({ x: -380, y: 20, width: 380, height: 500 })
  })

  it('never creates a window larger than a work area smaller than the normal minimums', () => {
    expect(calculatePrimarySidebarBounds(
      { x: 50, y: 40, width: 250, height: 400 },
      { width: 100, height: 100 },
    )).toEqual({ x: 50, y: 40, width: 250, height: 400 })
  })
})
