import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';

interface ResetPasswordPageProps {
  redirectUrl?: string;
}

const ResetPasswordPage: React.FC<ResetPasswordPageProps> = ({ redirectUrl = '/dashboard' }) => {
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  
  const navigate = useNavigate();

  useEffect(() => {
    // Listen for the PASSWORD_RECOVERY event
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          // This event fires when the user clicks the link in their email.
          // The Supabase client has automatically authenticated the user.
          // You can now show the form to reset the password.
          setShowForm(true);
          
          // Store the user's email for login after password reset
          if (session?.user?.email) {
            setUserEmail(session.user.email);
          }
        }
      }
    );

    return () => {
      // Cleanup the listener when the component unmounts
      authListener.subscription.unsubscribe();
    };
  }, []);

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');

    if (!newPassword) {
      setError('Password cannot be empty.');
      return;
    }

    setLoading(true);

    // Call updateUser to set the new password
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    // Password updated successfully, now log in with the new password
    if (userEmail) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: newPassword,
      });

      if (signInError) {
        setError('Password reset successful, but login failed. Please try logging in manually.');
        setLoading(false);
        return;
      }

      // Login successful, redirect to the specified URL
      setMessage('Password reset successful! Redirecting...');
      setTimeout(() => {
        navigate(redirectUrl);
      }, 1500);
    } else {
      // If we don't have the email, just show success message
      setMessage('Your password has been reset successfully! You can now log in.');
      setShowForm(false);
      setTimeout(() => {
        navigate('/login');
      }, 2000);
    }
    
    setLoading(false);
  };

  if (!showForm) {
    // You can show a loading spinner or a message
    // while the client library is processing the token.
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Verifying your request...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" style={{ width: '100%' }}>
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8" style={{ maxWidth: '100%' }}>
        <div className="w-full max-w-md mx-auto flex flex-col items-center" style={{ maxWidth: '28rem' }}>
          {/* Logo */}
          <img src="https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/757b23a3-9ec0-457d-2634-29e28f03fe00/verysmall" alt="Mentra Logo" />

          {/* Header */}
          <div className="w-full text-center mt-6 mb-6">
            <h1 className="text-2xl font-bold mb-2">
              Set Your New Password
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Enter your new password below
            </p>
          </div>

          {/* Card */}
          <div className="w-full bg-white p-8 rounded-lg shadow-md">
            <form onSubmit={handlePasswordReset}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-2">
                    New Password
                  </label>
                  <input
                    type="password"
                    id="newPassword"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    required
                    disabled={loading}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 bg-emerald-400 hover:bg-emerald-500 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium rounded text-sm transition-colors duration-200"
                  style={{ borderRadius: '4px', fontSize: '14px', fontWeight: '500' }}
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Saving...
                    </span>
                  ) : (
                    'Save New Password'
                  )}
                </button>
              </div>
            </form>

            {message && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-md mt-4">
                <p className="text-sm text-green-700 text-center">
                  {message}
                </p>
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md mt-4">
                <p className="text-sm text-red-700 text-center">
                  {error}
                </p>
              </div>
            )}

            {/* Sign In Link */}
            <div className="text-center text-sm text-gray-500 mt-6">
              <a
                href="/login"
                className="cursor-pointer underline"
              >
                Back to sign in
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ResetPasswordPage;