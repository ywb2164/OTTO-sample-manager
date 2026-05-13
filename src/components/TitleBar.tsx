import React, { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  Files,
  FolderDown,
  Minus,
  Pin,
  PinOff,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useSampleStore } from '@/store/sampleStore'
import appIconUrl from '../../tmp-app-icon.png'

interface Props {
  onImportFiles: () => void
  onImportFolder: () => void
  onAssembleLyrics: () => void
  onRemoveAllImported: () => void
  isImporting: boolean
}

export const TitleBar: React.FC<Props> = ({
  onImportFiles,
  onImportFolder,
  onAssembleLyrics,
  onRemoveAllImported,
  isImporting,
}) => {
  const [alwaysOnTop, setAlwaysOnTop] = useState(true)
  const [opacity, setOpacity] = useState(1.0)
  const [appVersion, setAppVersion] = useState('')
  const [enableAutoCopy, setEnableAutoCopy] = useState(true)
  const [keepCopies, setKeepCopies] = useState(false)
  const [showImportMenu, setShowImportMenu] = useState(false)
  const [showSettingsMenu, setShowSettingsMenu] = useState(false)
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false)
  const {
    folderSettings,
    setExpandOnSearch,
    setFolderClassificationEnabled,
    setMemoryOptimizationMode,
    setEnableChinesePinyinFuzzySearch,
  } = useSampleStore()

  useEffect(() => {
    window.electronAPI.getAlwaysOnTop().then(setAlwaysOnTop)
    window.electronAPI.getOpacity().then(setOpacity)
    window.electronAPI.getAppVersion().then(setAppVersion).catch(() => setAppVersion(''))
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

  const updateCopySettings = async (next: { enableAutoCopy?: boolean; keepCopies?: boolean }) => {
    const previousSettings = {
      enableAutoCopy,
      keepCopies,
    }
    const nextSettings = {
      enableAutoCopy,
      keepCopies,
      ...next
    }

    try {
      if (next.enableAutoCopy !== undefined) setEnableAutoCopy(next.enableAutoCopy)
      if (next.keepCopies !== undefined) setKeepCopies(next.keepCopies)

      await window.electronAPI.storeSet('copySettings', nextSettings)
    } catch {
      setEnableAutoCopy(previousSettings.enableAutoCopy)
      setKeepCopies(previousSettings.keepCopies)
      window.alert('副本设置保存失败，请重试。')
    }
  }

  const handleOpenLink = (url: string) => {
    window.electronAPI.openExternalLink(url)
  }

  const handleCheckForUpdates = async () => {
    if (isCheckingForUpdates) return

    setIsCheckingForUpdates(true)
    try {
      await window.electronAPI.checkForUpdates({
        silentIfNoUpdate: false,
        showErrors: true,
      })
    } finally {
      setIsCheckingForUpdates(false)
    }
  }

  const iconButtonClassName =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary'
  const menuPanelClassName =
    'absolute top-full right-0 mt-2 z-[100] rounded-lg border border-white/5 bg-zinc-950/95 shadow-lg shadow-black/30 backdrop-blur-xl'

  return (
    <div
      className="relative z-50 flex h-10 flex-shrink-0 items-center gap-1.5 overflow-visible border-b border-white/5 bg-zinc-950/90 px-2.5 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-text-secondary">
        <img src={appIconUrl} alt="" className="h-6 w-6 flex-shrink-0 rounded-md object-contain" />
        <span className="truncate text-xs font-medium">采样管理器</span>
      </div>

      <div
        className="flex items-center gap-1.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          className="inline-flex h-7 items-center gap-1 rounded-md bg-accent-primary px-2.5 text-xs font-medium text-white shadow-sm shadow-accent-primary/20 transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onAssembleLyrics}
          disabled={isImporting}
          title="活字印刷生成"
        >
          <Sparkles size={13} />
          <span className="hidden min-[430px]:inline">活字印刷</span>
        </button>

        <div className="relative">
          <button
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated/80 px-2 text-xs font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              if (isImporting) return
              setShowImportMenu(prev => !prev)
              setShowSettingsMenu(false)
            }}
            disabled={isImporting}
          >
            <Download size={13} />
            <span>{isImporting ? '导入中' : '导入'}</span>
            {!isImporting && <ChevronDown size={12} />}
          </button>
          {showImportMenu && !isImporting && (
            <div className={`${menuPanelClassName} min-w-40 py-1.5`}>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover"
                onClick={() => { onImportFiles(); setShowImportMenu(false) }}
              >
                <Files size={14} />
                <span>导入文件</span>
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover"
                onClick={() => { onImportFolder(); setShowImportMenu(false) }}
              >
                <FolderDown size={14} />
                <span>导入文件夹</span>
              </button>
              <div className="my-1 border-t border-border-subtle" />
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10"
                onClick={() => { onRemoveAllImported(); setShowImportMenu(false) }}
              >
                <Trash2 size={14} />
                <span>移除全部导入</span>
              </button>
            </div>
          )}
        </div>

        <div className="relative">
          <button
            className={iconButtonClassName}
            onClick={() => {
              setShowSettingsMenu(prev => !prev)
              setShowImportMenu(false)
            }}
            title="设置"
          >
            <Settings size={15} />
          </button>
          {showSettingsMenu && (
            <div className={`${menuPanelClassName} w-72 p-3`}>
              <div className="space-y-3">
                <SettingCheckbox
                  checked={folderSettings.expandOnSearch}
                  label="搜索时展开文件夹"
                  onChange={setExpandOnSearch}
                />
                <SettingCheckbox
                  checked={folderSettings.folderClassificationEnabled}
                  label="按文件夹分类"
                  onChange={setFolderClassificationEnabled}
                />
                <SettingCheckbox
                  checked={folderSettings.enableChinesePinyinFuzzySearch}
                  label="中文模糊搜索"
                  note="仅将中文查询扩展为同音素材名。"
                  onChange={setEnableChinesePinyinFuzzySearch}
                />
                <SettingCheckbox
                  checked={enableAutoCopy}
                  label="启用自动副本"
                  note="单个素材可多次使用且分别独立。"
                  onChange={(value) => updateCopySettings({ enableAutoCopy: value })}
                />
                <SettingCheckbox
                  checked={keepCopies}
                  label="保留自动副本"
                  note="关闭时清理拖拽生成的外部编辑副本。"
                  onChange={(value) => updateCopySettings({ keepCopies: value })}
                />
                <SettingCheckbox
                  checked={folderSettings.memoryOptimizationMode}
                  label="内存优化模式"
                  note="仅加载当前可见范围附近的音频数据。"
                  onChange={setMemoryOptimizationMode}
                />

                <div className="border-t border-border-subtle pt-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-text-secondary">
                    <span>窗口透明度</span>
                    <span className="font-mono text-text-muted">{opacity.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.2"
                    max="1.0"
                    step="any"
                    value={opacity}
                    className="w-full"
                    onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
                  />
                </div>

                <div className="border-t border-border-subtle pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-text-secondary">
                    <span className="truncate">版本 {appVersion || '读取中'}</span>
                    <button
                      className="inline-flex items-center gap-1 rounded-md bg-accent-dim px-2 py-1.5 text-xs text-accent-light transition-colors hover:bg-accent-primary/25 disabled:cursor-wait disabled:opacity-70"
                      onClick={handleCheckForUpdates}
                      disabled={isCheckingForUpdates}
                    >
                      <CheckCircle2 size={13} />
                      <span>{isCheckingForUpdates ? '检查中' : '检查更新'}</span>
                    </button>
                  </div>
                </div>

                <div className="border-t border-border-subtle pt-3">
                  <div className="mb-2 text-center text-[11px] text-text-dim">Authors</div>
                  <div className="grid grid-cols-1 gap-1">
                    <ExternalButton label="杨薇柏_Official" onClick={() => handleOpenLink('https://space.bilibili.com/1042301441')} />
                    <ExternalButton label="_Candace_" onClick={() => handleOpenLink('https://space.bilibili.com/364700163')} />
                    <button
                      className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                      onClick={() => handleOpenLink('https://github.com/ywb2164/OTTO-sample-manager')}
                    >
                      <ExternalLink size={13} />
                      <span>Github</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <button
          className={`${iconButtonClassName} ${alwaysOnTop ? 'bg-accent-dim text-accent-light' : ''}`}
          onClick={toggleAlwaysOnTop}
          title={alwaysOnTop ? '取消置顶' : '窗口置顶'}
        >
          {alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
        </button>

        <div className="ml-1 h-5 w-px bg-border-subtle" />

        <button
          className={iconButtonClassName}
          onClick={() => window.electronAPI.minimizeWindow()}
          title="最小化"
        >
          <Minus size={15} />
        </button>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-red-500/90 hover:text-white"
          onClick={() => window.electronAPI.closeWindow()}
          title="关闭"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

const SettingCheckbox: React.FC<{
  checked: boolean
  label: string
  note?: string
  onChange: (value: boolean) => void
}> = ({ checked, label, note, onChange }) => (
  <label className="flex cursor-pointer items-start gap-2 text-xs text-text-primary">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
    />
    <span className="min-w-0">
      <span className="block">{label}</span>
      {note && <span className="mt-0.5 block text-[11px] leading-4 text-text-dim">{note}</span>}
    </span>
  </label>
)

const ExternalButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
    onClick={onClick}
  >
    <ExternalLink size={13} />
    <span className="truncate">{label}</span>
  </button>
)
