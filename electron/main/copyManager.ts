import { app } from 'electron'
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, extname, join } from 'path'

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
let resolvedCopiesRoot: string | null = null
const TRANSIENT_COPIES_DIR_NAME = 'drag-copies'
const LYRICS_ASSEMBLIES_DIR_NAME = 'lyrics-assemblies'

function getPreferredCopiesRoot(): string {
  if (app.isPackaged) {
    return join(dirname(app.getPath('exe')), 'Copy')
  }

  return join(app.getAppPath(), 'Copy')
}

function getFallbackCopiesRoot(): string {
  return join(app.getPath('userData'), 'Copy')
}

async function resolveCopiesRoot(): Promise<string> {
  if (resolvedCopiesRoot) {
    return resolvedCopiesRoot
  }

  const candidates = [getPreferredCopiesRoot(), getFallbackCopiesRoot()]

  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true })
      resolvedCopiesRoot = candidate
      return candidate
    } catch {
      continue
    }
  }

  throw new Error('Unable to resolve a writable copy directory')
}

export async function getCopiesRoot(): Promise<string> {
  return resolveCopiesRoot()
}

export async function getManagedCopiesDir(): Promise<string> {
  const root = await resolveCopiesRoot()
  const dir = join(root, TRANSIENT_COPIES_DIR_NAME)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function getLyricsAssembliesDir(): Promise<string> {
  const root = await resolveCopiesRoot()
  const dir = join(root, LYRICS_ASSEMBLIES_DIR_NAME)
  await mkdir(dir, { recursive: true })
  return dir
}

function sanitizeBaseName(sourcePath: string): string {
  const ext = extname(sourcePath)
  const originalName = basename(sourcePath, ext)
  const asciiName = originalName
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

  return asciiName || 'sample'
}

function buildCopyPrefix(sourcePath: string, originalId: string): string {
  const safeName = sanitizeBaseName(sourcePath)
  const shortId = originalId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'source'
  return `${safeName}_${shortId}_copy`
}

function buildCopyFileName(sourcePath: string, originalId: string, copyIndex: number): string {
  const ext = extname(sourcePath)
  return `${buildCopyPrefix(sourcePath, originalId)}${copyIndex}${ext.toLowerCase()}`
}

async function getNextCopyIndex(copiesRoot: string, sourcePath: string, originalId: string): Promise<number> {
  if (!existsSync(copiesRoot)) return 1

  const ext = extname(sourcePath).toLowerCase()
  const prefix = buildCopyPrefix(sourcePath, originalId)
  const files = await readdir(copiesRoot)

  let maxIndex = 0

  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith(ext)) {
      continue
    }

    const indexText = file.slice(
      prefix.length,
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

  const copiesRoot = await getManagedCopiesDir()

  const copyIndex = await getNextCopyIndex(copiesRoot, item.filePath, item.id)
  const targetPath = join(copiesRoot, buildCopyFileName(item.filePath, item.id, copyIndex))

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
  await rm(await getManagedCopiesDir(), { recursive: true, force: true })
}
