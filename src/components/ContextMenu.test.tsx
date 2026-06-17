import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu } from './ContextMenu'
import { useSampleStore } from '@/store/sampleStore'
import type { Sample, SampleFolder, SampleGroup } from '@/types'

function createSample(id: string, groupIds: string[] = []): Sample {
  return {
    id,
    fileName: id,
    fileExt: '.wav',
    filePath: `D:/samples/${id}.wav`,
    folderId: null,
    originalId: id,
    isCopy: false,
    copyIndex: 0,
    duration: 0,
    sampleRate: 44100,
    channels: 2,
    fileSize: 1024,
    groupIds,
    importedAt: 1,
    isDecoded: false,
    isFileValid: true,
  }
}

function createFolder(id: string, sampleIds: string[], childFolderIds: string[] = []): SampleFolder {
  return {
    id,
    name: id,
    path: `D:/samples/${id}`,
    sampleIds,
    childFolderIds,
    parentId: null,
    rootId: id,
    depth: 0,
    importedAt: 1,
    isExpanded: true,
    order: 0,
    isRenaming: false,
  }
}

function createGroup(id: string): SampleGroup {
  return {
    id,
    name: 'Favorites',
    color: '#2563eb',
    sampleIds: [],
  }
}

describe('ContextMenu', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    useSampleStore.setState({
      samples: new Map(),
      groups: new Map(),
      folders: new Map(),
      selectedIds: new Set(),
      hiddenSampleIds: new Set(),
      hiddenFolderIds: new Set(),
      contextMenuTarget: null,
      showSelectionBar: false,
      lastGroupChangeTimestamp: Date.now(),
    })
  })

  it('opens after initially rendering empty without changing hook order', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(<ContextMenu />)

    act(() => {
      useSampleStore.setState({
        samples: new Map([['sample-a', createSample('sample-a')]]),
        contextMenuTarget: {
          type: 'sample',
          id: 'sample-a',
          x: 12,
          y: 24,
        },
      })
    })

    expect(() => rerender(<ContextMenu />)).not.toThrow()
    expect(screen.getByText('隐藏')).toBeTruthy()
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('adds every sample in a folder subtree to the selected group', () => {
    const rootFolder = createFolder('root', ['sample-a'], ['child'])
    const childFolder = {
      ...createFolder('child', ['sample-b']),
      parentId: 'root',
      rootId: 'root',
      depth: 1,
    }

    useSampleStore.setState({
      samples: new Map([
        ['sample-a', createSample('sample-a')],
        ['sample-b', createSample('sample-b')],
      ]),
      folders: new Map([
        ['root', rootFolder],
        ['child', childFolder],
      ]),
      groups: new Map([['favorites', createGroup('favorites')]]),
      contextMenuTarget: {
        type: 'folder',
        id: 'root',
        x: 12,
        y: 24,
      },
    })

    render(<ContextMenu />)

    fireEvent.click(screen.getByRole('button', { name: /分配.*分组/ }))
    fireEvent.click(screen.getByText('Favorites'))

    const state = useSampleStore.getState()
    expect(state.samples.get('sample-a')?.groupIds).toContain('favorites')
    expect(state.samples.get('sample-b')?.groupIds).toContain('favorites')
    expect(state.groups.get('favorites')?.sampleIds).toEqual(['sample-a', 'sample-b'])
  })
})
