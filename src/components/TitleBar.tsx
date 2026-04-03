import React, { useState, useEffect } from 'react'
import { useSampleStore } from '@/store/sampleStore'

interface Props {
  onImportFiles: () => void
  onImportFolder: () => void
  onRemoveAllImported: () => void
}

export const TitleBar: React.FC<Props> = ({ onImportFiles, onImportFolder, onRemoveAllImported }) => {
  const [alwaysOnTop, setAlwaysOnTop] = useState(true)
  const [opacity, setOpacity] = useState(1.0)
  const [enableAutoCopy, setEnableAutoCopy] = useState(true)
  const [keepCopies, setKeepCopies] = useState(false)
  const [showImportMenu, setShowImportMenu] = useState(false)
  const [showSettingsMenu, setShowSettingsMenu] = useState(false)
  const { folderSettings, setExpandOnSearch, setFolderClassificationEnabled } = useSampleStore()

  useEffect(() => {
    window.electronAPI.getAlwaysOnTop().then(setAlwaysOnTop)
  }, [])

  useEffect(() => {
    window.electronAPI.getOpacity().then(setOpacity)
  }, [])

  useEffect(() => {
    const restoreCopySettings = async () => {
      const storedCopySettings = await window.electronAPI.storeGet('copySettings') as {
        enableAutoCopy?: boolean
        keepCopies?: boolean
      } | null
      if (!storedCopySettings) return
      setEnableAutoCopy(storedCopySettings.enableAutoCopy ?? true)
      setKeepCopies(storedCopySettings.keepCopies ?? false)
    }

    restoreCopySettings()
  }, [])

  const toggleAlwaysOnTop = () => {
    const next = !alwaysOnTop
    setAlwaysOnTop(next)
    window.electronAPI.setAlwaysOnTop(next)
  }

  const handleOpacityChange = (value: number) => {
    setOpacity(value)
    window.electronAPI.setOpacity(value)
  }

  const updateCopySettings = (next: { enableAutoCopy?: boolean; keepCopies?: boolean }) => {
    const nextSettings = {
      enableAutoCopy,
      keepCopies,
      ...next
    }

    if (next.enableAutoCopy !== undefined) {
      setEnableAutoCopy(next.enableAutoCopy)
    }
    if (next.keepCopies !== undefined) {
      setKeepCopies(next.keepCopies)
    }

    window.electronAPI.storeSet('copySettings', nextSettings)
  }

  const handleEnableAutoCopyChange = (value: boolean) => {
    updateCopySettings({ enableAutoCopy: value })
  }

  const handleKeepCopiesChange = (value: boolean) => {
    updateCopySettings({ keepCopies: value })
  }

  return (
    // -webkit-app-region: drag 让这个区域可以拖动窗口
    <div
      className="flex items-center h-9 px-3 gap-2 bg-bg-secondary border-b border-border flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 标题 */}
      <span className="text-xs text-text-secondary flex-1 font-medium">
        🎵 采样管理器
      </span>

      {/* 控制按钮区（不参与拖动）*/}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* 导入菜单 */}
        <div className="relative">
          <button
            className="text-xs px-2 py-1 rounded bg-accent-primary hover:bg-accent-light text-white transition-colors"
            onClick={() => setShowImportMenu(!showImportMenu)}
          >
            导入 ▾
          </button>
          {showImportMenu && (
            <div className="absolute top-full right-0 mt-1 bg-bg-tertiary border border-border rounded shadow-lg z-50 min-w-32">
              <button
                className="block w-full text-left text-xs px-3 py-2 hover:bg-bg-hover text-text-primary"
                onClick={() => { onImportFiles(); setShowImportMenu(false) }}
              >
                导入文件
              </button>
              <button
                className="block w-full text-left text-xs px-3 py-2 hover:bg-bg-hover text-text-primary"
                onClick={() => { onImportFolder(); setShowImportMenu(false) }}
              >
                导入文件夹
              </button>
              <div className="border-t border-border my-1"></div>
              <button
                className="block w-full text-left text-xs px-3 py-2 hover:bg-bg-hover text-red-400"
                onClick={() => { onRemoveAllImported(); setShowImportMenu(false) }}
              >
                移除全部导入
              </button>
            </div>
          )}
        </div>

        {/* 设置按钮 */}
        <div className="relative">
          <button
            className="text-xs px-2 py-1 rounded text-text-dim hover:text-text-primary transition-colors"
            onClick={() => setShowSettingsMenu(!showSettingsMenu)}
            title="设置"
          >
            ⚙
          </button>
          {showSettingsMenu && (
            <div className="absolute top-full right-0 mt-1 bg-bg-tertiary border border-border rounded shadow-lg z-50 min-w-48 p-2">
              <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={folderSettings.expandOnSearch}
                  onChange={(e) => setExpandOnSearch(e.target.checked)}
                />
                <span>搜索时文件栏展开/收回</span>
              </label>
              <div className="border-t border-border my-2"></div>
              <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={folderSettings.folderClassificationEnabled}
                  onChange={(e) => setFolderClassificationEnabled(e.target.checked)}
                />
                <span>按文件夹分类</span>
              </label>
              <div className="border-t border-border my-2"></div>
              <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableAutoCopy}
                  onChange={(e) => handleEnableAutoCopyChange(e.target.checked)}
                />
                <span>启用自动副本</span>
              </label>
              <div className="text-[11px] text-text-dim mt-1 leading-4">
                勾选后，单个素材可多次使用且分别独立
              </div>
              <div className="border-t border-border my-2"></div>
              <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={keepCopies}
                  onChange={(e) => handleKeepCopiesChange(e.target.checked)}
                />
                <span>保留自动副本</span>
              </label>
              <div className="text-[11px] text-text-dim mt-1 leading-4">
                关闭时默认清理拖拽生成的外部编辑副本
              </div>
              <div className="border-t border-border my-2"></div>
              <div className="flex justify-between items-center text-xs text-text-primary w-full gap-2">
                <span className="whitespace-nowrap">窗口透明度:</span>
                <input
                  type="range"
                  min="0.2"
                  max="1.0"
                  step="any"
                  value={opacity}
                  className="flex-1"
                  onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
                />
                <span className="text-xs text-text-dim w-8 text-right whitespace-nowrap">
                  {opacity.toFixed(2)}
                </span>
              </div>
              <div className="border-t border-border my-2"></div>
              <div className="text-xs text-text-dim whitespace-nowrap text-center">关注杨薇柏_Official谢谢喵~</div>
            </div>
          )}
        </div>

        {/* 置顶按钮 */}
        <button
          className={`text-xs px-2 py-1 rounded transition-colors ${
            alwaysOnTop
              ? 'bg-accent-dim text-accent-light'
              : 'text-text-dim hover:text-text-primary'
          }`}
          onClick={toggleAlwaysOnTop}
          title={alwaysOnTop ? '取消置顶' : '窗口置顶'}
        >
          📌
        </button>

        {/* 最小化 */}
        <button
          className="text-xs w-6 h-6 flex items-center justify-center rounded hover:bg-bg-hover text-text-dim"
          onClick={() => window.electronAPI.minimizeWindow()}
        >
          ─
        </button>

        {/* 关闭 */}
        <button
          className="text-xs w-6 h-6 flex items-center justify-center rounded hover:bg-red-600 text-text-dim"
          onClick={() => window.electronAPI.closeWindow()}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
