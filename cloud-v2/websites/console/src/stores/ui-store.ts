import { create } from "zustand";

type UiState = {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

export const useUiStore = create<UiState>()(set => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set(state => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
