/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"Segoe UI"', 'sans-serif'],
        mono: ['"SF Mono"', '"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      colors: {
        bg: {
          primary: '#09090b',
          secondary: '#111113',
          tertiary: '#18181b',
          canvas: '#09090b',
          surface: '#111113',
          elevated: '#18181b',
          glass: 'rgb(9 9 11 / <alpha-value>)',
          hover: 'rgb(255 255 255 / 0.055)',
          selected: 'rgb(37 99 235 / 0.10)',
        },
        accent: {
          primary: '#2563eb',
          light: '#60a5fa',
          dim: 'rgb(37 99 235 / 0.12)',
          blue: '#2563eb',
        },
        text: {
          primary: '#f4f4f5',
          secondary: '#a1a1aa',
          muted: '#a1a1aa',
          dim: '#71717a',
        },
        border: {
          DEFAULT: 'rgb(255 255 255 / 0.07)',
          subtle: 'rgb(255 255 255 / 0.05)',
          strong: 'rgb(255 255 255 / 0.12)',
          primary: 'rgb(255 255 255 / 0.07)',
        },
        waveform: {
          played: '#2563eb',
          unplayed: '#a1a1aa',
          playhead: '#fafafa',
        }
      }
    }
  },
  plugins: []
}
