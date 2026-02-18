import React from 'react';
import ForgotPasswordForm from '../components/ForgotPassword';

const ForgotPasswordPage: React.FC = () => {
  return (
    <ForgotPasswordForm
      redirectTo={`${window.location.origin}/reset-password`}
      logoUrl="https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/757b23a3-9ec0-457d-2634-29e28f03fe00/verysmall"
    />
  );
};

export default ForgotPasswordPage;