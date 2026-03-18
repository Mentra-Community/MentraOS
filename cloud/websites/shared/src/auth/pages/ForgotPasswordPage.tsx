import React from 'react';
import ForgotPasswordForm from '../components/ForgotPassword';

const ForgotPasswordPage: React.FC = () => {
  return (
    <ForgotPasswordForm
      redirectTo={`${window.location.origin}/reset-password`}
    />
  );
};

export default ForgotPasswordPage;