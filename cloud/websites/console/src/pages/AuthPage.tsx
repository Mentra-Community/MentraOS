import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, LoginUI } from '@mentra/shared';
import api from '../services/api.service';
import { toast } from 'sonner';

const AuthPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, refreshUser, tokenReady } = useAuth();
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const [inviteHandled, setInviteHandled] = useState(false);
  const inviteToken = searchParams.get('token');
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
  useEffect(() => {
    if (isAuthenticated && tokenReady && inviteToken && !inviteHandled) {
      handleInvite(inviteToken);
    }
  }, [isAuthenticated, tokenReady, inviteToken, inviteHandled]);

  useEffect(() => {
    if (isAuthenticated && !inviteToken) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate, inviteToken]);

  if (isLoading) {
    return <div>Loading...</div>;
  }

  const inviteMessage = inviteToken && !inviteHandled
    ? isAuthenticated
      ? 'Processing invitation...'
      : 'You have been invited to join an organization. Please sign in or create an account to accept the invitation.'
    : undefined;

  return (
    <LoginUI
      siteName="Developer Portal"
      message={inviteMessage}
      redirectTo={
        inviteToken
          ? `${window.location.origin}/signin?token=${inviteToken}`
          : `${window.location.origin}/dashboard`
      }
      emailRedirectPath="/dashboard"
      isEmailModalOpen={isEmailModalOpen}
      setIsEmailModalOpen={setIsEmailModalOpen}
    />
  );
};

export default AuthPage;