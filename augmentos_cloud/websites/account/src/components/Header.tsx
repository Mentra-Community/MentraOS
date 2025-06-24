import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Button } from './ui/button';

const Header: React.FC = () => {
  const { isAuthenticated, signOut, user } = useAuth();
  const navigate = useNavigate();

  // Handle sign out
  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <header className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
      <div className="mx-auto px-10 py-4">
        <div className="flex items-center justify-between">

          {/* Logo and Site Name */}
          <div className="flex flex-col items-start select-none">
            <Link to="/" className="flex items-end ">
              <img src="https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/757b23a3-9ec0-457d-2634-29e28f03fe00/verysmall" alt="Mentra Logo" />
            </Link>
            <span className="font-light text-sm text-gray-800">Account</span>
          </div>

          {/* Authentication */}
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
                  size="sm"
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
        </div>
      </div>
    </header>
  );
};

export default Header;