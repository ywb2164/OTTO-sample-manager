import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportSummary } from '@/types'
import { ImportResultBanner } from './ImportResultBanner'

function createSummary(overrides: Partial<ImportSummary> = {}): ImportSummary {
  return {
    scanned: 471,
    added: 0,
    linkedToGroup: 460,
    skipped: 11,
    failed: 0,
    targetGroupId: 'group-a',
    failures: [],
    ...overrides,
  }
}

describe('ImportResultBanner', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows all import counts, target group and allows manual dismissal', () => {
    const onClose = vi.fn()
    render(<ImportResultBanner summary={createSummary()} targetGroupName="电棍音源" onClose={onClose} />)

    expect(screen.getByText(/扫描 471/)).toBeTruthy()
    expect(screen.getByText(/添加 0/)).toBeTruthy()
    expect(screen.getByText(/归组 460/)).toBeTruthy()
    expect(screen.getByText(/跳过 11/)).toBeTruthy()
    expect(screen.getByText(/失败 0/)).toBeTruthy()
    expect(screen.getByText(/电棍音源/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '关闭导入结果' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('auto-dismisses a successful result after eight seconds', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<ImportResultBanner summary={createSummary()} targetGroupName="电棍音源" onClose={onClose} />)

    act(() => vi.advanceTimersByTime(8000))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps failures visible and exposes their path and reason', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const summary = createSummary({
      failed: 1,
      failures: [{ path: 'D:\\blocked', stage: 'scan', reason: 'access denied' }],
    })
    render(<ImportResultBanner summary={summary} targetGroupName={null} onClose={onClose} />)

    act(() => vi.advanceTimersByTime(16000))

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('D:\\blocked')).toBeTruthy()
    expect(screen.getByText(/access denied/)).toBeTruthy()
  })
})
