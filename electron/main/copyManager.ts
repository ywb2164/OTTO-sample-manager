import { app } from 'electron'
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, extname, join } from 'path'

export interface CopySourceItem {
  id: string
  filePath: string
}

export interface CopyRecord {
  id: string
  filePath: string
  originalId: string
  isCopy: true
  copyIndex: number
  createdAt: number
}

const copyRecords = new Map<string, CopyRecord>()

function getCopiesRoot(): string {
  return join(app.getPath('userData'), 'temp_copies')
}

function getCopyDir(originalId: string): string {
  return join(getCopiesRoot(), originalId)
}

function buildCopyFileName(sourcePath: string, copyIndex: number): string {
  const ext = extname(sourcePath)
  const originalName = basename(sourcePath, ext)
  return `${originalName}_副本${copyIndex}${ext}`
}

async function getNextCopyIndex(copyDir: string, sourcePath: string): Promise<number> {
  if (!existsSync(copyDir)) return 1

  const ext = extname(sourcePath)
  const originalName = basename(sourcePath, ext)
  const files = await readdir(copyDir)

  let maxIndex = 0

  for (const file of files) {
    if (!file.startsWith(`${originalName}_副本`) || !file.endsWith(ext)) {
      continue
    }

    const indexText = file.slice(
      `${originalName}_副本`.length,
      file.length - ext.length,
    )
    const index = Number.parseInt(indexText, 10)
    if (!Number.isNaN(index)) {
      maxIndex = Math.max(maxIndex, index)
    }
  }

  return maxIndex + 1
}

export async function createManagedCopy(item: CopySourceItem): Promise<CopyRecord> {
  if (!existsSync(item.filePath)) {
    throw new Error(`Source file does not exist: ${item.filePath}`)
  }

  const copyDir = getCopyDir(item.id)
  await mkdir(copyDir, { recursive: true })

  const copyIndex = await getNextCopyIndex(copyDir, item.filePath)
  const targetPath = join(copyDir, buildCopyFileName(item.filePath, copyIndex))

  await copyFile(item.filePath, targetPath)

  const record: CopyRecord = {
    id: `${item.id}_copy_${copyIndex}_${Date.now()}`,
    filePath: targetPath,
    originalId: item.id,
    isCopy: true,
    copyIndex,
    createdAt: Date.now(),
  }

  copyRecords.set(record.filePath, record)
  return record
}

export function getManagedCopyRecords(): CopyRecord[] {
  return [...copyRecords.values()]
}

export async function cleanupManagedCopies(): Promise<void> {
  copyRecords.clear()
  await rm(getCopiesRoot(), { recursive: true, force: true })
}
