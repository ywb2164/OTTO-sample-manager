const PINYIN_CHAR_MAP: Record<string, string> = {
  ā: 'a',
  á: 'a',
  ǎ: 'a',
  à: 'a',
  ē: 'e',
  é: 'e',
  ě: 'e',
  è: 'e',
  ī: 'i',
  í: 'i',
  ǐ: 'i',
  ì: 'i',
  ō: 'o',
  ó: 'o',
  ǒ: 'o',
  ò: 'o',
  ū: 'u',
  ú: 'u',
  ǔ: 'u',
  ù: 'u',
  ǖ: 'v',
  ǘ: 'v',
  ǚ: 'v',
  ǜ: 'v',
  ü: 'v',
  ń: 'n',
  ň: 'n',
  ǹ: 'n',
  ḿ: 'm',
}

const PINYIN_VARIANT_REGEX = new RegExp(`[${Object.keys(PINYIN_CHAR_MAP).join('')}]`, 'g')

export function normalizePinyinToken(input: string): string {
  return input
    .toLowerCase()
    .replace(/[1-5]/g, '')
    .replace(PINYIN_VARIANT_REGEX, (char) => PINYIN_CHAR_MAP[char] ?? char)
    .replace(/[^a-zv]/g, '')
}
