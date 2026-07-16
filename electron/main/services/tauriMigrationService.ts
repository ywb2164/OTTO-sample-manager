import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

export interface TauriMigrationManifest {
  schemaVersion: 1
  version: string
  installerUrl: string
  sha256: string
  signature: string
}

export interface TauriMigrationDependencies {
  downloadFile?: (url: string, targetPath: string) => Promise<void>
  launchInstaller?: (installerPath: string) => void
}

export class TauriMigrationService {
  private readonly publicKeyPem: string
  private readonly downloadFile: (url: string, targetPath: string) => Promise<void>
  private readonly launchInstaller: (installerPath: string) => void

  constructor(publicKeyPem: string, dependencies: TauriMigrationDependencies = {}) {
    this.publicKeyPem = publicKeyPem
    this.downloadFile = dependencies.downloadFile ?? downloadHttpsFile
    this.launchInstaller = dependencies.launchInstaller ?? launchNsisInstaller
  }

  verifyManifest(manifest: TauriMigrationManifest): void {
    if (manifest.schemaVersion !== 1) throw new Error('unsupported-migration-manifest')
    if (!/^https:\/\//i.test(manifest.installerUrl)) throw new Error('insecure-installer-url')
    if (!/^[a-f\d]{64}$/i.test(manifest.sha256)) throw new Error('invalid-installer-sha256')
    const signature = Buffer.from(manifest.signature, 'base64')
    const valid = verify(
      null,
      manifestPayload(manifest),
      createPublicKey(this.publicKeyPem),
      signature,
    )
    if (!valid) throw new Error('invalid-migration-signature')
  }

  async downloadAndVerify(
    manifest: TauriMigrationManifest,
    installerPath: string,
  ): Promise<string> {
    this.verifyManifest(manifest)
    try {
      await this.downloadFile(manifest.installerUrl, installerPath)
      const actualHash = await sha256File(installerPath)
      if (actualHash !== manifest.sha256.toLowerCase()) {
        throw new Error('installer-hash-mismatch')
      }
      return installerPath
    } catch (error) {
      await rm(installerPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  launchVerifiedInstaller(installerPath: string): void {
    this.launchInstaller(installerPath)
  }
}

export function manifestPayload(
  manifest: Omit<TauriMigrationManifest, 'signature'>,
): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    installerUrl: manifest.installerUrl,
    sha256: manifest.sha256.toLowerCase(),
  }))
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function downloadHttpsFile(url: string, targetPath: string, redirects = 0): Promise<void> {
  if (redirects > 5) throw new Error('too-many-download-redirects')
  await new Promise<void>((resolve, reject) => {
    const request = httpsGet(url, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume()
        const redirectUrl = new URL(location, url).toString()
        downloadHttpsFile(redirectUrl, targetPath, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`installer-download-http-${status}`))
        return
      }
      pipeline(response, createWriteStream(targetPath)).then(resolve, reject)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('installer-download-timeout')))
    request.on('error', reject)
  })
}

function launchNsisInstaller(installerPath: string): void {
  const child = spawn(installerPath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

export async function readMigrationManifest(filePath: string): Promise<TauriMigrationManifest> {
  return JSON.parse(await readFile(filePath, 'utf8')) as TauriMigrationManifest
}
