import { pinyin } from 'pinyin-pro'
import type { LyricToken } from '@/types/lyrics'

function isChineseChar(char: string): boolean {
  return /[\u3400-\u9fff]/.test(char)
}

function decodeWithEncoding(buffer: ArrayBuffer, encoding: string): string {
  return new TextDecoder(encoding, { fatal: false }).decode(buffer)
}

export function decodeLyricsText(buffer: ArrayBuffer): string {
  const utf8 = decodeWithEncoding(buffer, 'utf-8')
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length

  if (replacementCount > 0) {
    try {
      const gb18030 = decodeWithEncoding(buffer, 'gb18030')
      const gbReplacementCount = (gb18030.match(/\uFFFD/g) ?? []).length
      if (gbReplacementCount < replacementCount) {
        return gb18030
      }
    } catch {
      // ignore fallback failure
    }
  }

  return utf8
}

export function tokenizeLyricsText(text: string): LyricToken[] {
  const normalizedText = text.replace(/\r\n?/g, '\n')
  const tokens: LyricToken[] = []

  for (const char of normalizedText) {
    if (char === '\n') {
      tokens.push({ type: 'newline', raw: '\n' })
      continue
    }

    if (isChineseChar(char)) {
      let value = ''
      try {
        value = pinyin(char, { toneType: 'none', type: 'array' })[0] ?? ''
      } catch {
        value = ''
      }

      tokens.push({
        type: 'char',
        char,
        pinyin: value.toLowerCase(),
      })
      continue
    }

    tokens.push({ type: 'separator', raw: char })
  }

  return tokens
}

export function getDefaultLyricsGroupName(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const baseName = normalizedPath.split('/').pop() || '歌词分组'
  const dotIndex = baseName.lastIndexOf('.')
  return dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName
}
