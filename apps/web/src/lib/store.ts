import { create } from 'zustand';

export type LiveStatus = 'connecting' | 'open' | 'closed';

interface UiState {
  /** WebSocket connection status, driven by the live client. */
  liveStatus: LiveStatus;
  setLiveStatus: (status: LiveStatus) => void;
}

export const useUiStore = create<UiState>((set) => ({
  liveStatus: 'closed',
  setLiveStatus: (liveStatus) => set({ liveStatus }),
}));
