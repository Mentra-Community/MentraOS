import { useState, useEffect } from 'react';

/**
 * Hook to extract and manage the token from the URL
 * 
 * @returns The token or null if not found
 */
export function useToken(): string | null {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Extract token from URL
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    
    if (urlToken) {
      // Store token
      setToken(urlToken);
      
      // Remove token from URL for security
      // This prevents the token from being visible in the browser history
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
    }
  }, []);

  return token;
}