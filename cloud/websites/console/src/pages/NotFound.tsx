// pages/NotFound.tsx
import React from 'react';
import { Button } from "@mentra/shared";
import { Link } from 'react-router-dom';

const NotFound: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-secondary px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-foreground">404</h1>
        <h2 className="mt-2 text-2xl font-medium text-foreground">Page not found</h2>
        <p className="mt-4 text-muted-foreground">The page you are looking for doesn't exist or has been moved.</p>
        <div className="mt-8">
          <Button asChild>
            <Link to="/dashboard">Back to Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;