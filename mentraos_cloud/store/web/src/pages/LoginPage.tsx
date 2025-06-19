import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../utils/supabase';
import Header from '../components/Header';
import { Button } from '../components/ui/button';
import EmailAuthModal from '../components/EmailAuthModal';

const LoginPage: React.FC = () => {
  // const navigate = useNavigate();
  const location = useLocation();
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);

  // Get the redirect path from location state or default to home
  const from = (location.state)?.from?.pathname || (location.state)?.returnTo || '/';
  
  // Store the redirect path for the email login flow
  React.useEffect(() => {
    if (from && from !== '/') {
      localStorage.setItem('auth_redirect', from);
    }
  }, [from]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="container mx-auto px-4 py-8 flex-1 flex items-center justify-center">
        <div className="max-w-md w-full bg-white p-8 rounded-lg shadow-md flex flex-col items-center">
          {/* Logo and Site Name */}
          <div className="flex items-end select-none">
            <h1 className="font-cuprum font-bold text-5xl">.\</h1>
            <h1 className="font-light text-2xl pb-0.5 pl-1 text-gray-800">ugment</h1>
            <h1 className="font-bold text-2xl pb-0.5">OS</h1>
          </div>
          <span className="ml-2 font-medium text-lg text-gray-800 mb-6">Store</span>

          <div className="w-full space-y-4">
            <div className="text-center mb-2">
              <h2 className="text-xl font-semibold">Sign in to continue</h2>
              <p className="text-sm text-gray-500 mt-1">Choose your preferred sign in method</p>
            </div>
            
            {/* Google Sign In Button */}
            <Auth
              supabaseClient={supabase}
              appearance={{ 
                theme: ThemeSupa,
                style: {
                  button: {
                    borderRadius: '4px',
                    fontSize: '14px',
                    fontWeight: '500',
                  },
                  anchor: {
                    display: 'none'
                  },
                  container: {
                    width: '100%'
                  }
                },
                // Hide everything except the google button
                className: {
                  message: 'hidden',
                  divider: 'hidden',
                  label: 'hidden',
                  input: 'hidden',
                  button: 'hidden',
                }
              }}
              providers={['google', 'apple']}
              view="sign_in"
              redirectTo={`${window.location.origin}${from}`}
              showLinks={false}
              onlyThirdPartyProviders={true}
            />
            
            {/* Email Sign In Button */}
            <div className="w-full flex flex-col items-center space-y-4 mt-4">
              <div className="flex items-center w-full">
                <div className="flex-grow h-px bg-gray-300"></div>
                <div className="px-4 text-sm text-gray-500">or</div>
                <div className="flex-grow h-px bg-gray-300"></div>
              </div>
              
              <Button 
                className="w-full py-2" 
                onClick={() => setIsEmailModalOpen(true)}
                variant="outline"
              >
                Sign in with Email
              </Button>
            </div>
          </div>

          <div className="text-center text-sm text-gray-500 mt-6">
            <p>By signing in, you agree to our Terms of Service and Privacy Policy.</p>
          </div>
          
          {/* Email Auth Modal */}
          <EmailAuthModal 
            open={isEmailModalOpen} 
            onOpenChange={setIsEmailModalOpen} 
          />
        </div>
      </main>
    </div>
  );
};

export default LoginPage;