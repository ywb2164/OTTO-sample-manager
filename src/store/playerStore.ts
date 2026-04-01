import { create } from 'zustand'

interface PlayerState {
  currentSampleId: string | null
  currentFilePath: string | null
  isPlaying: boolean
  currentTime: number
  duration: number
  setCurrentSampleId: (id: string | null) => void
  setCurrentFilePath: (path: string | null) => void
  setIsPlaying: (isPlaying: boolean) => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentSampleId: null,
  currentFilePath: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  setCurrentSampleId: (id) => set({ currentSampleId: id }),
  setCurrentFilePath: (path) => set({ currentFilePath: path }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration })
}))
