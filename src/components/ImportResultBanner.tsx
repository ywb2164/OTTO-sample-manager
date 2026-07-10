import React, { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import type { ImportFailureStage, ImportSummary } from '@/types'

interface Props {
  summary: ImportSummary
  targetGroupName: string | null
  onClose: () => void
}

const stageLabels: Record<ImportFailureStage, string> = {
  scan: '扫描',
  metadata: '读取',
  commit: '提交',
}

export const ImportResultBanner: React.FC<Props> = ({ summary, targetGroupName, onClose }) => {
  useEffect(() => {
    if (summary.failed > 0) return
    const timeoutId = window.setTimeout(onClose, 8000)
    return () => window.clearTimeout(timeoutId)
  }, [onClose, summary])

  const hasFailures = summary.failed > 0

  return (
    <section
      aria-live={hasFailures ? 'assertive' : 'polite'}
      className={`border-b px-3 py-2 text-xs ${
        hasFailures
          ? 'border-amber-500/20 bg-amber-500/[0.08] text-amber-100'
          : 'border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-100'
      }`}
    >
      <div className="flex items-start gap-2">
        {hasFailures
          ? <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-amber-300" />
          : <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-emerald-300" />}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">导入完成</span>
            <span>扫描 {summary.scanned}</span>
            <span>添加 {summary.added}</span>
            <span>归组 {summary.linkedToGroup}</span>
            <span>跳过 {summary.skipped}</span>
            <span>失败 {summary.failed}</span>
          </div>
          {targetGroupName && (
            <div className="mt-1 text-[11px] text-zinc-300">目标分组：{targetGroupName}</div>
          )}

          {hasFailures && (
            <details className="mt-2 text-[11px] text-zinc-200">
              <summary className="cursor-pointer select-none text-amber-200">查看失败详情</summary>
              <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded bg-black/20 p-2">
                {summary.failures.map((failure, index) => (
                  <li key={`${failure.stage}-${failure.path}-${index}`} className="break-all">
                    <span className="mr-1 text-amber-300">[{stageLabels[failure.stage]}]</span>
                    <span>{failure.path}</span>
                    <span className="ml-1 text-zinc-400">— {failure.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <button
          type="button"
          aria-label="关闭导入结果"
          onClick={onClose}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          <X size={14} />
        </button>
      </div>
    </section>
  )
}
