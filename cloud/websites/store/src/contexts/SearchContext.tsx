import React, { createContext, useContext, useState, useRef, useCallback, ReactNode } from "react";

interface SearchContextType {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isSearching: boolean;
  setIsSearching: (searching: boolean) => void;
  registerSearchInput: (input: HTMLInputElement | null) => void;
  focusSearchInput: () => void;
}

const SearchContext = createContext<SearchContextType | undefined>(undefined);

export const SearchProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const registerSearchInput = useCallback((input: HTMLInputElement | null) => {
    searchInputRef.current = input;
  }, []);

  const focusSearchInput = useCallback(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, []);

  return (
    <SearchContext.Provider
      value={{ searchQuery, setSearchQuery, isSearching, setIsSearching, registerSearchInput, focusSearchInput }}>
      {children}
    </SearchContext.Provider>
  );
};

export const useSearch = () => {
  const context = useContext(SearchContext);
  if (context === undefined) {
    throw new Error("useSearch must be used within a SearchProvider");
  }
  return context;
};
