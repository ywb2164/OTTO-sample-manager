import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TauriMigrationService,
  manifestPayload,
  sha256File,
  type TauriMigrationManifest,
} from './tauriMigrationService'

const temporaryFiles: string[] = []

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map(async (file) => {
    const { rm } = await import('node:fs/promises')
    await rm(file, { force: true })
  }))
})

describe('Electron to Tauri migration manifest', () => {
  it('downloads and launches only an Ed25519-signed installer with the declared hash', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const source = `${process.cwd()}\\migration-source-${Date.now()}.exe`
    const target = `${process.cwd()}\\migration-target-${Date.now()}.exe`
    temporaryFiles.push(source, target)
    await writeFile(source, 'signed Tauri installer')

    const unsigned = {
      schemaVersion: 1 as const,
      version: '3.0.0',
      installerUrl: 'https://example.test/otto-setup.exe',
      sha256: await sha256File(source),
    }
    const manifest: TauriMigrationManifest = {
      ...unsigned,
      signature: sign(null, manifestPayload(unsigned), privateKey).toString('base64'),
    }
    const launchInstaller = vi.fn()
    const service = new TauriMigrationService(
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      {
        downloadFile: async (_url, destination) => {
          await writeFile(destination, await readFile(source))
        },
        launchInstaller,
      },
    )

    await expect(service.downloadAndVerify(manifest, target)).resolves.toBe(target)
    service.launchVerifiedInstaller(target)
    expect(launchInstaller).toHaveBeenCalledWith(target)

    await expect(service.downloadAndVerify({ ...manifest, version: '3.0.1' }, target))
      .rejects.toThrow('invalid-migration-signature')
  })

  it('removes a download whose bytes do not match the signed hash', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const target = `${process.cwd()}\\migration-bad-${Date.now()}.exe`
    temporaryFiles.push(target)
    const unsigned = {
      schemaVersion: 1 as const,
      version: '3.0.0',
      installerUrl: 'https://example.test/otto-setup.exe',
      sha256: '0'.repeat(64),
    }
    const manifest = {
      ...unsigned,
      signature: sign(null, manifestPayload(unsigned), privateKey).toString('base64'),
    }
    const service = new TauriMigrationService(
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      { downloadFile: async (_url, destination) => writeFile(destination, 'tampered') },
    )

    await expect(service.downloadAndVerify(manifest, target)).rejects.toThrow('installer-hash-mismatch')
  })
})
