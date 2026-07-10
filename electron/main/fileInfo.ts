import { stat } from 'fs/promises'

export interface FileInfoResult {
  path: string
  exists: boolean
  fileSize: number
  reason?: string
}

export interface FileStatProvider {
  stat(filePath: string): Promise<{ size: number }>
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function getFilesInfo(
  filePaths: string[],
  provider: FileStatProvider = { stat },
  concurrency = 16,
): Promise<FileInfoResult[]> {
  const results: FileInfoResult[] = new Array(filePaths.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), filePaths.length)

  const worker = async () => {
    while (nextIndex < filePaths.length) {
      const index = nextIndex
      nextIndex += 1
      const filePath = filePaths[index]
      try {
        const fileStat = await provider.stat(filePath)
        results[index] = { path: filePath, exists: true, fileSize: fileStat.size }
      } catch (error) {
        results[index] = { path: filePath, exists: false, fileSize: 0, reason: failureReason(error) }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}
