import React, {useState, useEffect} from 'react';
import {useNavigate} from 'react-router-dom';
import {supabase} from '../utils/supabase';
import {mapAuthError} from '../utils/authErrors';
import {Button} from '../components/ui/button';
import {Input} from '../components/ui/input';
import {Label} from '../components/ui/label';
import {Spinner} from '../components/ui/spinner';
import {IMAGES} from '../../constants/images';
import {FiEye, FiEyeOff} from 'react-icons/fi';

interface ResetPasswordPageProps {
  redirectUrl?: string;
  logoUrl?: string;
}

const ResetPasswordPage: React.FC<ResetPasswordPageProps> = ({
  redirectUrl = '/dashboard',
  logoUrl = IMAGES.iconOnly,
}) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [userEmail, setUserEmail] = useState('');

  const navigate = useNavigate();

  useEffect(() => {
    // Listen for the PASSWORD_RECOVERY event
    const {data: authListener} = supabase.auth.onAuthStateChange(
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

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);

    // Call updateUser to set the new password
    const {error: updateError} = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setError(mapAuthError(updateError));
      setLoading(false);
      return;
    }

    // Password updated successfully, now log in with the new password
    if (userEmail) {
      const {error: signInError} = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: newPassword,
      });

      if (signInError) {
        setError(mapAuthError(signInError));
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
    // Show a loading state while processing the token
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <div className="text-center flex flex-col items-center">
          <Spinner size="lg" className="mb-4" />
          <p className="text-muted-foreground">Verifying your request...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col w-full">
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-sm mx-auto flex flex-col items-center">
          {/* Icon */}
          <img src={logoUrl} alt="Mentra Logo" className="h-24 w-24" />

          {/* Wordmark */}
          <p className="text-[46px] text-secondary-foreground text-center pt-8 pb-4">
            Mentra
          </p>

          {/* Header */}
          <p className="text-xl text-secondary-foreground text-center mb-4">
            Set Your New Password
          </p>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Enter your new password below
          </p>

          {/* Form */}
          <form onSubmit={handlePasswordReset} className="w-full space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="newPassword">New Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  id="newPassword"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPassword ? <FiEyeOff className="w-5 h-5" /> : <FiEye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <div className="relative">
                <Input
                  type={showConfirmPassword ? 'text' : 'password'}
                  id="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showConfirmPassword ? <FiEyeOff className="w-5 h-5" /> : <FiEye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? (
                <>
                  <Spinner size="sm" />
                  Saving...
                </>
              ) : (
                'Save New Password'
              )}
            </Button>

            {/* Success Message */}
            {message && (
              <div className="text-sm text-accent text-center mt-2">
                {message}
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div className="text-sm text-destructive text-center mt-2">
                {error}
              </div>
            )}
          </form>

          {/* Back to sign in link */}
          <div className="flex items-center justify-center gap-1 mt-6">
            <a
              href="/login"
              className="text-sm text-accent font-semibold cursor-pointer hover:underline">
              Back to sign in
            </a>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ResetPasswordPage;