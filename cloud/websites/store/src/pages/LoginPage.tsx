import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth, LoginUI } from '@mentra/shared';

const LoginPage: React.FC = () => {
  const location = useLocation();
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
  const { isAuthenticated, isLoading } = useAuth();
  
  const from = location.state?.from?.pathname || location.state?.returnTo || '/';

  useEffect(() => {
    if (from && from !== '/') {
      localStorage.setItem('auth_redirect', from);
    }
  }, [from])

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      const localRedirect = localStorage.getItem('auth_redirect');
      const urlParams = new URLSearchParams(window.location.search);
      const redirectToFromURLParams = urlParams.get('redirectTo');
      const redirectTo = redirectToFromURLParams || localRedirect || '/';
      localStorage.removeItem('auth_redirect');
      setTimeout(() => {
        window.location.href = window.location.origin + redirectTo;
      }, 300);
    }
  }, [isAuthenticated, isLoading]);

  return (
    <LoginUI
      siteName="App Store"
      redirectTo={`${window.location.origin}${from}`}
      emailRedirectPath="/"
      isEmailModalOpen={isEmailModalOpen}
      setIsEmailModalOpen={setIsEmailModalOpen}
    />
  );
};

export default LoginPage
