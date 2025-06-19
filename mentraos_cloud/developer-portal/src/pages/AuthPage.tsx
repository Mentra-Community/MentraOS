// src/pages/AuthPage.tsx
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../utils/supabase';
import { useAuth } from '../hooks/useAuth';
import { Button } from "@/components/ui/button";
import EmailAuthModal from '../components/EmailAuthModal';
import api from '../services/api.service';
import { toast } from 'sonner';

declare const window: Window & typeof globalThis;

/**
 * Authentication page component
 * Handles user authentication and organization invitation acceptance
 */
const AuthPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, refreshUser, tokenReady } = useAuth();
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const [inviteHandled, setInviteHandled] = useState(false);
  const inviteToken = searchParams.get('token');

  /**
   * Handle organization invitation acceptance
   * @param token - The invitation token from URL
   */
  const handleInvite = async (token: string) => {
    try {

      // Accept the invitation using the orgs.acceptInvite method
      const orgResponse = await api.orgs.acceptInvite(token);

      // Show success message with the organization name
      toast.success(`You have been added to ${orgResponse.name}!`);
      setInviteHandled(true);

      // Refresh user data to update organization membership
      await refreshUser();

      // Force a page reload to ensure all context data is refreshed
      setTimeout(() => {
        window.location.href = `/org-settings?welcome=true&orgName=${encodeURIComponent(orgResponse.name)}&orgId=${orgResponse.id}`;
      }, 500);
    } catch (error: any) {
      console.error('Error accepting invite:', error);

      // Handle specific error cases
      if (error.response?.status === 400 &&
          error.response?.data?.message?.includes('already a member')) {
        // If user is already a member, show a friendly message instead of an error
        toast.info('You are already a member of this organization');
        const orgId = error.response?.data?.message?.split(':')[1]?.trim();
        setInviteHandled(true);
        // Still reload to take them to organization settings
        setTimeout(() => {
          window.location.href = `/org-settings?existing=true&orgId=${orgId}`;
        }, 500);
        return;
      }

      if (error.response?.status === 400 &&
          error.response?.data?.message?.includes('already been accepted')) {
        // If invite has already been accepted, show a friendly message
        toast.info('This invitation has already been used');
        setInviteHandled(true);
        navigate('/dashboard');
        return;
      }

      if (error.response?.status === 400 &&
          error.response?.data?.message?.includes('expired')) {
        // If invite has expired, show appropriate message
        toast.error('This invitation has expired. Please request a new invitation.');
        setInviteHandled(true);
        navigate('/dashboard');
        return;
      }

      // Provide more specific error messages based on the error
      if (error.response?.data?.message) {
        toast.error(`Invitation error: ${error.response.data.message}`);
      } else {
        toast.error('Failed to accept the invitation. It may be invalid or expired.');
      }
    }
  };

  // Check for invite token and process it when authenticated
  useEffect(() => {
    if (isAuthenticated && tokenReady && inviteToken && !inviteHandled) {
      handleInvite(inviteToken);
    }
  }, [isAuthenticated, tokenReady, inviteToken, inviteHandled]);

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (isAuthenticated && !inviteToken) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate, inviteToken]);

  // Show email authentication modal
  const showEmailAuth = () => {
    setIsEmailModalOpen(true);
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="container mx-auto max-w-md py-12">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold mb-2">Welcome to AugmentOS Developer Portal</h1>
        <p className="text-gray-600">Sign in or create an account to continue</p>
        {inviteToken && !inviteHandled && (
          <div className="mt-4 p-3 bg-blue-50 rounded-md text-blue-700">
            You have been invited to join an organization.
            {isAuthenticated ? 'Processing invitation...' : 'Please sign in or create an account to accept the invitation.'}
          </div>
        )}
      </div>

      <div className="bg-white p-8 rounded-lg shadow-md">
        <div className="flex flex-col gap-4">
          <Button variant="outline" onClick={showEmailAuth}>
            Continue with Email
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-gray-500">Or continue with</span>
            </div>
          </div>

          <Auth
            supabaseClient={supabase}
            appearance={{ theme: ThemeSupa }}
            providers={['github', 'google']}
            redirectTo={
              inviteToken
                ? `${window.location.origin}/signin?token=${inviteToken}`
                : `${window.location.origin}/dashboard`
            }
          />
        </div>
      </div>

      <EmailAuthModal
        open={isEmailModalOpen}
        onOpenChange={setIsEmailModalOpen}
      />
    </div>
  );
};

export default AuthPage;