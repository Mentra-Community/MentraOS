import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Button } from './ui/button';
import { Baseline } from 'lucide-react';

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
            ><img src="https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/9520c05b-2fd0-4cd0-98c2-303b45df0200/verysmall" style={{ width: '30px', display: 'inline-block', marginRight: '10px', verticalAlign: 'baseline' }} alt="Mentra Logo" />
              App Store
            </span>
          </div>

          {/* Authentication */}
          {!isWebViewAuth && (
            <div className="flex items-center">
              {isAuthenticated ? (
                <div className="flex flex-col items-end">
                  {user?.email && (
                    <span className="text-sm text-white-600 px-3">
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