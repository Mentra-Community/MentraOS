import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth, LoginUI } from '@mentra/shared';

const LoginPage: React.FC = () => {
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);

  const urlParams = new URLSearchParams(window.location.search);
  const returnFromUrl = urlParams.get('returnTo');
  const from =
    returnFromUrl ||
    location.state?.from?.pathname ||
    location.state?.returnTo ||
    '/account';
  const message = location.state?.message;

  useEffect(() => {
    if (from && from !== '/' && from !== '/account') {
      localStorage.setItem('auth_redirect', from);
    }
  }, [from]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      const authRedirect = localStorage.getItem('auth_redirect');
      if (authRedirect) {
        localStorage.removeItem('auth_redirect');
        window.location.href = `${window.location.origin}${authRedirect}`;
      } else {
        window.location.href = `${window.location.origin}/account`;
      }
    }
  }, [isLoading, isAuthenticated]);

  return (
    <LoginUI
      siteName="Account"
      message={message}
      redirectTo={`${window.location.origin}/login`}
      emailRedirectPath="/"
      isEmailModalOpen={isEmailModalOpen}
      setIsEmailModalOpen={setIsEmailModalOpen}
    />
  );
};

export default LoginPage;