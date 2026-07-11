import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('electron-builder runtime dependency files', () => {
  it('does not globally exclude node_modules src directories', () => {
    const config = readFileSync('electron-builder.yml', 'utf8')

    expect(config).not.toContain("'!**/node_modules/**/src/**'")
  })

  it('keeps the release private until every update artifact has uploaded', () => {
    const config = readFileSync('electron-builder.yml', 'utf8')
    const workflow = readFileSync('.github/workflows/publish-windows.yml', 'utf8')
    const uploadStep = workflow.indexOf('npm run pack -- --publish always')
    const publishStep = workflow.indexOf('gh release edit "${{ github.ref_name }}" --draft=false --latest')

    expect(config).toContain('releaseType: draft')
    expect(uploadStep).toBeGreaterThan(-1)
    expect(publishStep).toBeGreaterThan(uploadStep)
  })
})
