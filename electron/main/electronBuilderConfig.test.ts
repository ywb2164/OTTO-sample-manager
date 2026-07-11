import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('electron-builder runtime dependency files', () => {
  it('does not globally exclude node_modules src directories', () => {
    const config = readFileSync('electron-builder.yml', 'utf8')

    expect(config).not.toContain("'!**/node_modules/**/src/**'")
  })
})
