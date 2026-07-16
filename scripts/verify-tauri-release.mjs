import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { readFileSync, statSync } from 'node:fs'

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`)
    }
    values.set(key.slice(2), value)
  }
  return values
}

function required(argumentsMap, name) {
  const value = argumentsMap.get(name)
  if (!value) throw new Error(`missing required argument --${name}`)
  return value
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase()
}

function readPeSubsystem(executable) {
  if (executable.length < 0x40 || executable.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('application is not a valid DOS/PE executable')
  }
  const peOffset = executable.readUInt32LE(0x3c)
  if (peOffset + 24 + 70 > executable.length) {
    throw new Error('application PE optional header is truncated')
  }
  if (executable.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('application has an invalid PE signature')
  }
  return executable.readUInt16LE(peOffset + 24 + 68)
}

function readCargoVersion(cargoToml) {
  const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1]
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (!version) throw new Error('unable to read [package] version from Cargo.toml')
  return version
}

function assertVersion(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} declares version ${actual}; expected ${expected}`)
  }
}

function verifyInstalledExecutable(built, installed) {
  if (built.equals(installed)) return true
  if (built.length !== installed.length) {
    throw new Error('installed executable differs outside the Tauri NSIS bundle marker')
  }

  const unknownMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK', 'ascii')
  const nsisMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS', 'ascii')
  const markerOffset = built.indexOf(unknownMarker)
  if (markerOffset < 0 || !installed.subarray(markerOffset, markerOffset + nsisMarker.length).equals(nsisMarker)) {
    throw new Error('installed executable differs outside the Tauri NSIS bundle marker')
  }

  const normalizedInstalled = Buffer.from(installed)
  unknownMarker.copy(normalizedInstalled, markerOffset)
  if (!built.equals(normalizedInstalled)) {
    throw new Error('installed executable differs outside the Tauri NSIS bundle marker')
  }
  return true
}

function main() {
  const args = parseArguments(process.argv.slice(2))
  const expectedVersion = required(args, 'expected-version')
  const executablePath = resolve(required(args, 'exe'))
  const installerPath = resolve(required(args, 'installer'))
  const packageJsonPath = resolve(args.get('package-json') ?? 'package.json')
  const tauriConfigPath = resolve(args.get('tauri-config') ?? 'src-tauri/tauri.conf.json')
  const cargoTomlPath = resolve(args.get('cargo-toml') ?? 'src-tauri/Cargo.toml')

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
  const cargoToml = readFileSync(cargoTomlPath, 'utf8')
  assertVersion('package.json', packageJson.version, expectedVersion)
  assertVersion('tauri.conf.json', tauriConfig.version, expectedVersion)
  assertVersion('Cargo.toml', readCargoVersion(cargoToml), expectedVersion)

  const installerName = basename(installerPath)
  if (!installerName.includes(expectedVersion)) {
    throw new Error(`installer name ${installerName} does not contain version ${expectedVersion}`)
  }

  const executable = readFileSync(executablePath)
  const subsystem = readPeSubsystem(executable)
  if (subsystem !== 2) {
    throw new Error(`expected Windows GUI subsystem 2, received ${subsystem}`)
  }
  const installer = readFileSync(installerPath)
  const installerBytes = statSync(installerPath).size
  if (installerBytes > 30 * 1024 * 1024) {
    throw new Error(`installer is ${(installerBytes / 1024 / 1024).toFixed(2)} MiB; limit is 30 MiB`)
  }

  const report = {
    version: expectedVersion,
    subsystem,
    executablePath,
    executableSha256: sha256(executable),
    executableBytes: executable.length,
    installerPath,
    installerSha256: sha256(installer),
    installerBytes,
  }

  const installedExecutableArgument = args.get('installed-exe')
  if (installedExecutableArgument) {
    const installedExecutablePath = resolve(installedExecutableArgument)
    const installedExecutable = readFileSync(installedExecutablePath)
    const installedSubsystem = readPeSubsystem(installedExecutable)
    if (installedSubsystem !== 2) {
      throw new Error(`installed executable expected Windows GUI subsystem 2, received ${installedSubsystem}`)
    }
    report.installedExecutablePath = installedExecutablePath
    report.installedExecutableSha256 = sha256(installedExecutable)
    report.installedSubsystem = installedSubsystem
    report.installedNormalizedMatch = verifyInstalledExecutable(executable, installedExecutable)
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
