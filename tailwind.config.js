/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 整体深色主题
        bg: {
          primary: '#0f0f17',
          secondary: '#1a1a2e',
          tertiary: '#16213e',
          hover: '#1f1f3a',
          selected: '#2d1b69',
        },
        accent: {
          primary: '#7c3aed',
          light: '#a855f7',
          dim: '#4c1d95',
        },
        text: {
          primary: '#e2e8f0',
          secondary: '#94a3b8',
          dim: '#475569',
        },
        border: '#2a2a4a',
        waveform: {
          played: '#7c3aed',
          unplayed: '#3a3a5c',
          playhead: '#ffffff',
        }
      }
    }
  },
  plugins: []
}
