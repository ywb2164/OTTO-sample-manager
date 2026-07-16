import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const verifier = resolve('scripts/verify-tauri-release.mjs')
const temporaryDirectories: string[] = []

function createFixture(subsystem: number, version = '2.6.0') {
  const directory = mkdtempSync(join(tmpdir(), 'otto-release-verifier-'))
  temporaryDirectories.push(directory)

  const executable = Buffer.alloc(512)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(0x80, 0x3c)
  executable.write('PE\0\0', 0x80, 'binary')
  executable.writeUInt16LE(subsystem, 0x80 + 24 + 68)
  const executablePath = join(directory, 'otto-sample-manager.exe')
  writeFileSync(executablePath, executable)

  const installerPath = join(directory, `采样管理器_${version}_x64-setup.exe`)
  writeFileSync(installerPath, Buffer.from('installer'))
  const packageJsonPath = join(directory, 'package.json')
  writeFileSync(packageJsonPath, JSON.stringify({ version }))
  const tauriConfigPath = join(directory, 'tauri.conf.json')
  writeFileSync(tauriConfigPath, JSON.stringify({ version }))
  const cargoTomlPath = join(directory, 'Cargo.toml')
  writeFileSync(cargoTomlPath, `[package]\nname = "otto-sample-manager"\nversion = "${version}"\n`)

  return {
    directory,
    executablePath,
    installerPath,
    packageJsonPath,
    tauriConfigPath,
    cargoTomlPath,
    version,
  }
}

function runVerifier(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(process.execPath, [
    verifier,
    '--exe', fixture.executablePath,
    '--installer', fixture.installerPath,
    '--expected-version', fixture.version,
    '--package-json', fixture.packageJsonPath,
    '--tauri-config', fixture.tauriConfigPath,
    '--cargo-toml', fixture.cargoTomlPath,
  ], { encoding: 'utf8' })
}

function runInstalledVerifier(fixture: ReturnType<typeof createFixture>, mutate: (buffer: Buffer) => void) {
  const built = Buffer.from(readFileSync(fixture.executablePath))
  const markerOffset = 300
  built.write('__TAURI_BUNDLE_TYPE_VAR_UNK', markerOffset, 'ascii')
  writeFileSync(fixture.executablePath, built)
  const installed = Buffer.from(built)
  installed.write('__TAURI_BUNDLE_TYPE_VAR_NSS', markerOffset, 'ascii')
  mutate(installed)
  const installedPath = join(fixture.directory, 'installed.exe')
  writeFileSync(installedPath, installed)

  return spawnSync(process.execPath, [
    verifier,
    '--exe', fixture.executablePath,
    '--installed-exe', installedPath,
    '--installer', fixture.installerPath,
    '--expected-version', fixture.version,
    '--package-json', fixture.packageJsonPath,
    '--tauri-config', fixture.tauriConfigPath,
    '--cargo-toml', fixture.cargoTomlPath,
  ], { encoding: 'utf8' })
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('Tauri release artifact verifier', () => {
  it('rejects a console-subsystem application binary', () => {
    const result = runVerifier(createFixture(3))

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'expected Windows GUI subsystem 2, received 3',
    )
  })

  it('reports hashes and version for a GUI application and matching installer', () => {
    const fixture = createFixture(2)
    const result = runVerifier(fixture)

    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      version: '2.6.0',
      subsystem: 2,
      executablePath: fixture.executablePath,
      installerPath: fixture.installerPath,
    })
    expect(report.executableSha256).toMatch(/^[A-F0-9]{64}$/)
    expect(report.installerSha256).toMatch(/^[A-F0-9]{64}$/)
  })

  it('accepts only the NSIS bundle marker rewrite in an installed executable', () => {
    const accepted = runInstalledVerifier(createFixture(2), () => undefined)
    expect(accepted.status).toBe(0)
    expect(JSON.parse(accepted.stdout)).toMatchObject({ installedNormalizedMatch: true })

    const rejected = runInstalledVerifier(createFixture(2), (buffer) => {
      buffer[450] ^= 0xff
    })
    expect(rejected.status).not.toBe(0)
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
      'installed executable differs outside the Tauri NSIS bundle marker',
    )
  })
})
