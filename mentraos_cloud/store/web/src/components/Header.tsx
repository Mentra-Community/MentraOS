import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Button } from './ui/button';

const Header: React.FC = () => {
  const { isAuthenticated, signOut, user, isWebViewAuth } = useAuth();
  const navigate = useNavigate();

  // Handle sign out
  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <header className="sticky top-0 z-10 bg-[#242454] border-b border-gray-200 shadow-sm">
      <div className="mx-auto px-4 py-4">
        <div className="flex items-end justify-between">

          {/* Logo and Site Name */}
          <div className="flex flex-col items-start select-none">
            <span
              className="text-2xl  tracking-wide text-[#F1F1F1]"
              style={{ fontFamily: '"SF Pro Rounded", sans-serif' }}
            >
              App Store
            </span>
          </div>
          
          {/* Authentication */}
          {!isWebViewAuth && (
            <div className="flex items-center">
              {isAuthenticated ? (
                <div className="flex flex-col items-end">
                  {user?.email && (
                    <span className="text-sm text-gray-600 px-3">
                      {user.email}
                    </span>
                  )}
                  <Button
                    onClick={handleSignOut}
                    variant="ghost"
                    size={'sm'}
                  >
                    Sign Out
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => navigate('/login')}
                  variant="default"
                >
                  Sign In
                </Button>
              )}
            </div>
          )}
          
        </div>
      </div>
    </header>
  );
};

export default Header;