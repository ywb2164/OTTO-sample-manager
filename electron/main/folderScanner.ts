import type { Dirent } from 'fs'
import { readdirSync } from 'fs'
import { extname, join } from 'path'

interface ScannedFolderNode {
  name: string
  path: string
  files: string[]
  children: ScannedFolderNode[]
}

interface ScanFailure {
  path: string
  stage: 'scan'
  reason: string
}

interface ScanFolderResult {
  root: ScannedFolderNode | null
  scannedFileCount: number
  failures: ScanFailure[]
}

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.aif', '.m4a'])

export type ReadDirectory = (directory: string) => Dirent[]

const readDirectory: ReadDirectory = (directory) => readdirSync(directory, { withFileTypes: true })

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function scanAudioFolder(
  folderPath: string,
  readEntries: ReadDirectory = readDirectory,
): ScanFolderResult {
  const failures: ScanFailure[] = []
  let scannedFileCount = 0

  const scanDirectory = (directory: string): ScannedFolderNode | null => {
    let entries: Dirent[]
    try {
      entries = readEntries(directory)
    } catch (error) {
      failures.push({
        path: directory,
        stage: 'scan',
        reason: failureReason(error),
      })
      return null
    }

    const node: ScannedFolderNode = {
      name: directory.replace(/\\/g, '/').split('/').pop() || directory,
      path: directory,
      files: [],
      children: [],
    }

    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        const child = scanDirectory(fullPath)
        if (child) node.children.push(child)
        continue
      }

      if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        node.files.push(fullPath)
        scannedFileCount += 1
      }
    }

    return node
  }

  return {
    root: scanDirectory(folderPath),
    scannedFileCount,
    failures,
  }
}
