import { create } from 'zustand'
import { Sample, SampleGroup, SampleFolder } from '@/types'


// 工具函数：从文件路径提取文件夹信息
function extractFolderInfo(filePath: string): {
  folderPath: string
  folderName: string
} {
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) {
    return { folderPath: '', folderName: '根目录' }
  }

  const folderPath = normalized.substring(0, lastSlash)
  const folderName = folderPath.split('/').pop() || '根目录'

  return { folderPath, folderName }
}

interface SampleStore {
  // 数据
  samples: Map<string, Sample>              // id -> Sample
  groups: Map<string, SampleGroup>          // id -> Group

  // 搜索和筛选
  searchQuery: string
  activeGroupId: string | null             // null = 显示全部

  // 选中
  selectedIds: Set<string>
  anchorId: string | null                  // Shift选中的锚点

  // 加载状态
  isImporting: boolean
  decodeProgress: { current: number; total: number } | null

  // 文件夹相关状态
  folders: Map<string, SampleFolder>          // id -> Folder
  folderOrder: string[]                      // 文件夹显示顺序
  expandedFolderIds: Set<string>             // 展开的文件夹ID
  preSearchExpandedFolderIds: Set<string> | null  // 搜索前的展开状态，用于恢复
  folderSettings: {
    expandOnSearch: boolean
    folderClassificationEnabled: boolean
  }

  // 隐藏状态
  hiddenSampleIds: Set<string>              // 隐藏的样本ID
  hiddenFolderIds: Set<string>              // 隐藏的文件夹ID

  // 右键菜单状态
  contextMenuTarget: {
    type: 'sample' | 'folder'
    id: string
    x: number
    y: number
  } | null
  // 是否显示选中操作栏
  showSelectionBar: boolean

  // 分组更改时间戳（用于强制刷新）
  lastGroupChangeTimestamp: number
  
  // actions
  addSamples: (samples: Sample[]) => void
  removeSamples: (ids: string[]) => void
  updateSample: (id: string, patch: Partial<Sample>) => void
  
  addGroup: (group: SampleGroup) => void
  removeGroup: (id: string) => void
  renameGroup: (id: string, name: string) => void
  addToGroup: (sampleIds: string[], groupId: string) => void
  removeFromGroup: (sampleIds: string[], groupId: string) => void
  
  setSearchQuery: (query: string) => void
  setActiveGroupId: (id: string | null) => void
  
  setSelected: (ids: Set<string>) => void
  toggleSelected: (id: string) => void
  selectRange: (fromId: string, toId: string, orderedIds: string[]) => void
  selectAll: () => void
  clearSelection: () => void
  setAnchorId: (id: string | null) => void
  
  setIsImporting: (value: boolean) => void
  setDecodeProgress: (progress: { current: number; total: number } | null) => void

  // 文件夹操作
  addFolder: (folder: SampleFolder) => void
  removeFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void
  toggleFolderExpanded: (id: string) => void
  setFolderExpanded: (id: string, expanded: boolean) => void
  moveFolder: (fromIndex: number, toIndex: number) => void
  setExpandOnSearch: (value: boolean) => void
  setFolderClassificationEnabled: (value: boolean) => void

  // 隐藏操作
  toggleSampleHidden: (sampleId: string) => void
  toggleFolderHidden: (folderId: string) => void
  unhideAll: () => void

  // 右键菜单操作
  openContextMenu: (type: 'sample' | 'folder', id: string, x: number, y: number) => void
  closeContextMenu: () => void
  setShowSelectionBar: (show: boolean) => void

  // 计算属性（通过 getter 实现）
  getFilteredSamples: () => Sample[]
  getOrderedIds: () => string[]
  getFolderForSample: (sampleId: string) => SampleFolder | null
  getFlattenedItems: () => (Sample | SampleFolder)[]
  getFolderSamples: (folderId: string) => Sample[]
}

export const useSampleStore = create<SampleStore>((set, get) => ({
  samples: new Map(),
  groups: new Map(),
  searchQuery: '',
  activeGroupId: null,
  selectedIds: new Set(),
  anchorId: null,
  isImporting: false,
  decodeProgress: null,

  // 文件夹相关初始状态
  folders: new Map(),
  folderOrder: [],
  expandedFolderIds: new Set(),
  preSearchExpandedFolderIds: null,
  folderSettings: {
    expandOnSearch: true,  // 搜索时默认展开包含匹配样本的文件夹
    folderClassificationEnabled: true  // 是否按文件夹分类
  },

  // 隐藏状态初始值
  hiddenSampleIds: new Set(),
  hiddenFolderIds: new Set(),

  // 右键菜单初始状态
  contextMenuTarget: null,
  // 选中操作栏初始状态
  showSelectionBar: false,
  // 分组更改时间戳
  lastGroupChangeTimestamp: Date.now(),

  addSamples: (newSamples) => set(state => {
    const samples = new Map(state.samples)
    const folders = new Map(state.folders)
    const folderOrder = [...state.folderOrder]
    const expandedFolderIds = new Set(state.expandedFolderIds)

    for (const s of newSamples) {
      // 以filePath去重，同路径不重复导入
      const exists = [...samples.values()].find(existing => existing.filePath === s.filePath)
      if (!exists) {
        samples.set(s.id, s)

        // 根据文件路径确定文件夹
        const { folderPath } = extractFolderInfo(s.filePath)
        const folderId = `folder_${folderPath}`

        let folder = folders.get(folderId)
        if (!folder) {
          // 创建新文件夹
          const { folderName } = extractFolderInfo(folderPath + '/dummy')
          folder = {
            id: folderId,
            name: folderName,
            path: folderPath,
            sampleIds: [],
            isExpanded: true, // 新文件夹默认展开
            order: 0,
            isRenaming: false
          }
          folders.set(folderId, folder)
          folderOrder.unshift(folderId)
          expandedFolderIds.add(folderId) // 新文件夹默认展开
        }

        // 将样本ID添加到文件夹（如果尚未添加）
        if (!folder.sampleIds.includes(s.id)) {
          folder.sampleIds.push(s.id)
        }
      }
    }

    return { samples, folders, folderOrder, expandedFolderIds }
  }),

  removeSamples: (ids) => set(state => {
    const samples = new Map(state.samples)
    const groups = new Map(state.groups)
    const folders = new Map(state.folders)
    const selectedIds = new Set(state.selectedIds)

    for (const id of ids) {
      samples.delete(id)
      selectedIds.delete(id)
    }

    // 从所有分组中移除
    for (const [gid, group] of groups) {
      groups.set(gid, {
        ...group,
        sampleIds: group.sampleIds.filter(sid => !ids.includes(sid))
      })
    }

    // 从所有文件夹中移除
    for (const [fid, folder] of folders) {
      folders.set(fid, {
        ...folder,
        sampleIds: folder.sampleIds.filter(sid => !ids.includes(sid))
      })
    }

    // 可选：删除空文件夹（暂时保留空文件夹）

    return { samples, groups, folders, selectedIds }
  }),

  updateSample: (id, patch) => set(state => {
    const samples = new Map(state.samples)
    const existing = samples.get(id)
    if (existing) {
      samples.set(id, { ...existing, ...patch })
    }
    return { samples }
  }),

  addGroup: (group) => set(state => {
    const groups = new Map(state.groups)
    groups.set(group.id, group)
    return { groups, lastGroupChangeTimestamp: Date.now() }
  }),

  removeGroup: (id) => set(state => {
    const groups = new Map(state.groups)
    const samples = new Map(state.samples)
    groups.delete(id)

    // 从所有采样中移除该分组引用
    for (const [sid, sample] of samples) {
      if (sample.groupIds.includes(id)) {
        samples.set(sid, {
          ...sample,
          groupIds: sample.groupIds.filter(gid => gid !== id)
        })
      }
    }
    return { groups, samples, lastGroupChangeTimestamp: Date.now() }
  }),

  renameGroup: (id, name) => set(state => {
    const groups = new Map(state.groups)
    const group = groups.get(id)
    if (group) groups.set(id, { ...group, name })
    return { groups, lastGroupChangeTimestamp: Date.now() }
  }),

  addToGroup: (sampleIds, groupId) => set(state => {
    const samples = new Map(state.samples)
    const groups = new Map(state.groups)

    for (const sid of sampleIds) {
      const s = samples.get(sid)
      if (s && !s.groupIds.includes(groupId)) {
        const newGroupIds = [...s.groupIds, groupId]
        samples.set(sid, { ...s, groupIds: newGroupIds })
      }
    }

    const group = groups.get(groupId)
    if (group) {
      const newSampleIds = [...new Set([...group.sampleIds, ...sampleIds])]
      groups.set(groupId, { ...group, sampleIds: newSampleIds })
    }

    return { samples, groups, lastGroupChangeTimestamp: Date.now() }
  }),

  removeFromGroup: (sampleIds, groupId) => set(state => {
    const samples = new Map(state.samples)
    const groups = new Map(state.groups)

    for (const sid of sampleIds) {
      const s = samples.get(sid)
      if (s) {
        const newGroupIds = s.groupIds.filter(g => g !== groupId)
        samples.set(sid, { ...s, groupIds: newGroupIds })
      }
    }

    const group = groups.get(groupId)
    if (group) {
      const newSampleIds = group.sampleIds.filter(sid => !sampleIds.includes(sid))
      groups.set(groupId, {
        ...group,
        sampleIds: newSampleIds
      })
    }

    return { samples, groups, lastGroupChangeTimestamp: Date.now() }
  }),

  setSearchQuery: (searchQuery) => set(state => {
    // 如果查询从空变为非空，保存当前展开状态
    const wasEmpty = !state.searchQuery.trim()
    const isEmpty = !searchQuery.trim()

    let preSearchExpandedFolderIds = state.preSearchExpandedFolderIds
    let expandedFolderIds = new Set(state.expandedFolderIds)

    if (wasEmpty && !isEmpty) {
      // 开始搜索：保存当前展开状态
      preSearchExpandedFolderIds = new Set(state.expandedFolderIds)

      // 如果设置要求展开文件夹，则展开包含匹配样本的文件夹
      if (state.folderSettings.expandOnSearch) {
        // 使用新搜索查询手动过滤样本（避免调用 get().getFilteredSamples() 使用旧状态）
        const q = searchQuery.toLowerCase().trim()
        const keywords = q.split(/\s+/).filter(k => k.length > 0)
        const filteredSampleIds = new Set<string>()

        for (const sample of state.samples.values()) {
          // 先检查分组过滤
          if (state.activeGroupId && !sample.groupIds.includes(state.activeGroupId)) {
            continue
          }

          // 检查所有关键词是否都出现在文件名中（忽略扩展名）
          const fileNameLower = sample.fileName.toLowerCase()

          // 检查所有关键词是否都出现在文件名中（忽略扩展名）
          const matches = keywords.every(keyword =>
            fileNameLower.includes(keyword)
          )
          if (matches) {
            filteredSampleIds.add(sample.id)
          }
        }

        // 展开包含匹配样本的文件夹
        for (const folder of state.folders.values()) {
          // 获取文件夹中的样本
          const folderSampleIds = folder.sampleIds
          const hasMatch = folderSampleIds.some(id => filteredSampleIds.has(id))
          if (hasMatch) {
            expandedFolderIds.add(folder.id)
          }
        }
      }
    } else if (!wasEmpty && isEmpty && state.preSearchExpandedFolderIds) {
      // 清除搜索：恢复之前的展开状态
      expandedFolderIds = new Set(state.preSearchExpandedFolderIds)
      preSearchExpandedFolderIds = null
    }

    return {
      searchQuery,
      expandedFolderIds,
      preSearchExpandedFolderIds
    }
  }),
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),

  setSelected: (selectedIds) => set({ selectedIds }),
  
  toggleSelected: (id) => set(state => {
    const selectedIds = new Set(state.selectedIds)
    selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id)
    return { selectedIds, anchorId: id }
  }),

  selectRange: (fromId, toId, orderedIds) => set(state => {
    const fromIdx = orderedIds.indexOf(fromId)
    const toIdx = orderedIds.indexOf(toId)
    if (fromIdx === -1 || toIdx === -1) return {}
    
    const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
    const rangeIds = orderedIds.slice(start, end + 1)
    return { selectedIds: new Set(rangeIds) }
  }),

  selectAll: () => set(state => {
    const ids = get().getOrderedIds()
    return { selectedIds: new Set(ids) }
  }),

  clearSelection: () => set({ selectedIds: new Set(), showSelectionBar: false }),
  setAnchorId: (anchorId) => set({ anchorId }),
  setIsImporting: (isImporting) => set({ isImporting }),
  setDecodeProgress: (decodeProgress) => set({ decodeProgress }),

  // 文件夹操作
  addFolder: (folder) => set(state => {
    const folders = new Map(state.folders)
    folders.set(folder.id, folder)
    const folderOrder = [folder.id, ...state.folderOrder]
    return { folders, folderOrder }
  }),
  removeFolder: (id) => set(state => {
    const folders = new Map(state.folders)
    folders.delete(id)
    const folderOrder = state.folderOrder.filter(fid => fid !== id)
    const expandedFolderIds = new Set(state.expandedFolderIds)
    expandedFolderIds.delete(id)
    return { folders, folderOrder, expandedFolderIds }
  }),
  renameFolder: (id, name) => set(state => {
    const folders = new Map(state.folders)
    const folder = folders.get(id)
    if (folder) folders.set(id, { ...folder, name })
    return { folders }
  }),
  toggleFolderExpanded: (id) => set(state => {
    const expandedFolderIds = new Set(state.expandedFolderIds)
    if (expandedFolderIds.has(id)) expandedFolderIds.delete(id)
    else expandedFolderIds.add(id)
    return { expandedFolderIds }
  }),
  setFolderExpanded: (id, expanded) => set(state => {
    const expandedFolderIds = new Set(state.expandedFolderIds)
    if (expanded) expandedFolderIds.add(id)
    else expandedFolderIds.delete(id)
    return { expandedFolderIds }
  }),
  moveFolder: (fromIndex, toIndex) => set(state => {
    const folderOrder = [...state.folderOrder]
    const [moved] = folderOrder.splice(fromIndex, 1)
    folderOrder.splice(toIndex, 0, moved)
    return { folderOrder }
  }),
  setExpandOnSearch: (value) => set(state => ({
    folderSettings: { ...state.folderSettings, expandOnSearch: value }
  })),
  setFolderClassificationEnabled: (value) => set(state => ({
    folderSettings: { ...state.folderSettings, folderClassificationEnabled: value }
  })),

  // 隐藏操作
  toggleSampleHidden: (sampleId) => set(state => {
    const hiddenSampleIds = new Set(state.hiddenSampleIds)
    if (hiddenSampleIds.has(sampleId)) {
      hiddenSampleIds.delete(sampleId)
    } else {
      hiddenSampleIds.add(sampleId)
    }
    return { hiddenSampleIds }
  }),
  toggleFolderHidden: (folderId) => set(state => {
    const hiddenFolderIds = new Set(state.hiddenFolderIds)
    if (hiddenFolderIds.has(folderId)) {
      hiddenFolderIds.delete(folderId)
    } else {
      hiddenFolderIds.add(folderId)
    }
    return { hiddenFolderIds }
  }),
  unhideAll: () => set({
    hiddenSampleIds: new Set(),
    hiddenFolderIds: new Set()
  }),

  // 右键菜单操作
  openContextMenu: (type, id, x, y) => set({
    contextMenuTarget: { type, id, x, y },
    showSelectionBar: true
  }),
  closeContextMenu: () => set({
    contextMenuTarget: null
  }),
  setShowSelectionBar: (show) => set({ showSelectionBar: show }),

  // 搜索+分组过滤
  getFilteredSamples: () => {
    const { samples, searchQuery, activeGroupId, hiddenSampleIds, hiddenFolderIds, folders } = get()
    let list = [...samples.values()]

    // 第一步：过滤隐藏的样本和隐藏文件夹中的样本
    // 计算隐藏文件夹中的所有样本ID
    const hiddenFolderSampleIds = new Set<string>()
    for (const folderId of hiddenFolderIds) {
      const folder = folders.get(folderId)
      if (folder) {
        folder.sampleIds.forEach(id => hiddenFolderSampleIds.add(id))
      }
    }

    // 过滤掉隐藏的样本和隐藏文件夹中的样本
    list = list.filter(s => {
      if (hiddenSampleIds.has(s.id)) return false
      if (hiddenFolderSampleIds.has(s.id)) return false
      return true
    })

    if (activeGroupId) {
      list = list.filter(s => s.groupIds.includes(activeGroupId))
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      // 将查询按空格分割为关键词，忽略空关键词
      const keywords = q.split(/\s+/).filter(k => k.length > 0)

      list = list.filter(s => {
        const fileNameLower = s.fileName.toLowerCase()

        // 检查所有关键词是否都出现在文件名中（忽略扩展名）
        return keywords.every(keyword => fileNameLower.includes(keyword))
      })
    }

    // 按导入时间排序
    return list.sort((a, b) => a.importedAt - b.importedAt)
  },

  getOrderedIds: () => {
    return get().getFilteredSamples().map(s => s.id)
  },

  getFolderForSample: (sampleId) => {
    const { folders } = get()
    for (const folder of folders.values()) {
      if (folder.sampleIds.includes(sampleId)) {
        return folder
      }
    }
    return null
  },

  getFolderSamples: (folderId) => {
    const { folders, samples } = get()
    const folder = folders.get(folderId)
    if (!folder) return []
    return folder.sampleIds.map(id => samples.get(id)).filter((s): s is Sample => s !== undefined)
  },

  getFlattenedItems: () => {
    const { folders, folderOrder, expandedFolderIds, folderSettings, hiddenFolderIds } = get()

    // 如果文件夹分类被禁用，直接返回按文件名排序的过滤样本
    if (!folderSettings.folderClassificationEnabled) {
      const filteredSamples = get().getFilteredSamples()
      // 按文件名字母排序（不区分大小写）
      const sortedSamples = filteredSamples.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' })
      )
      return sortedSamples
    }

    const items: (Sample | SampleFolder)[] = []

    // 获取过滤后的样本（根据搜索和分组）
    const filteredSamples = get().getFilteredSamples()
    const filteredSampleIds = new Set(filteredSamples.map(s => s.id))

    // 直接使用当前的展开状态，搜索时的展开逻辑已在 setSearchQuery 中处理
    const expandedIds = new Set(expandedFolderIds)

    // 计算所有文件夹中的样本ID（无论是否展开）
    const allFolderSampleIds = new Set<string>()
    for (const folder of folders.values()) {
      const folderSamples = get().getFolderSamples(folder.id)
      for (const sample of folderSamples) {
        allFolderSampleIds.add(sample.id)
      }
    }

    // 按folderOrder顺序遍历文件夹
    for (const folderId of folderOrder) {
      const folder = folders.get(folderId)
      if (!folder) continue

      // 跳过隐藏的文件夹
      if (hiddenFolderIds.has(folderId)) {
        continue
      }

      // 获取文件夹中过滤后的样本
      const folderSamples = get().getFolderSamples(folderId)
      const filteredFolderSamples = folderSamples.filter(s => filteredSampleIds.has(s.id))

      // 如果文件夹有匹配的样本，显示文件夹
      if (filteredFolderSamples.length > 0) {
        items.push(folder)

        // 如果文件夹展开，添加其过滤后的样本
        if (expandedIds.has(folderId)) {
          // 样本按导入时间排序
          const sortedSamples = filteredFolderSamples.sort((a, b) => a.importedAt - b.importedAt)
          items.push(...sortedSamples)
        }
      }
    }

    // 添加未分配到任何文件夹的过滤样本（如果有的话）
    // 注意：这里只添加不在任何文件夹中的样本
    const orphanSamples = filteredSamples.filter(s => !allFolderSampleIds.has(s.id))
    const sortedOrphanSamples = orphanSamples.sort((a, b) => a.importedAt - b.importedAt)
    items.push(...sortedOrphanSamples)
    return items
  },

}))
