import { describe, expect, it, vi } from 'vitest'
import { getFilesInfo, type FileStatProvider } from './fileInfo'

describe('getFilesInfo', () => {
  it('keeps input order, isolates individual errors, and caps stat concurrency at 16', async () => {
    let active = 0
    let maxActive = 0
    const stat = vi.fn(async (filePath: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      if (filePath === 'missing.wav') throw new Error('not found')
      return { size: Number(filePath.replace(/\D/g, '')) || 1 }
    })
    const paths = Array.from({ length: 20 }, (_, index) => `sample-${index}.wav`)
    paths.splice(7, 0, 'missing.wav')

    const result = await getFilesInfo(paths, { stat } satisfies FileStatProvider)

    expect(stat).toHaveBeenCalledTimes(21)
    expect(maxActive).toBeLessThanOrEqual(16)
    expect(result.map((item) => item.path)).toEqual(paths)
    expect(result[7]).toEqual({ path: 'missing.wav', exists: false, fileSize: 0, reason: 'not found' })
    expect(result[0]).toMatchObject({ path: 'sample-0.wav', exists: true })
  })
})
