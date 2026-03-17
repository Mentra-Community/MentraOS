import React from 'react';

// Export constants
export { IMAGES } from './constants/images';

// Export UI components
export { Button, buttonVariants, cn } from './auth/components/ui/button';
export type { ButtonProps } from './auth/components/ui/button';
export { Input } from './auth/components/ui/input';
export { Label } from './auth/components/ui/label';
export { Textarea } from './auth/components/ui/textarea';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './auth/components/ui/select';
export { Spinner } from './auth/components/ui/spinner';
export { Switch } from './auth/components/ui/switch';
export { Checkbox } from './auth/components/ui/checkbox';
export { Badge, badgeVariants } from './auth/components/ui/badge';
export { Alert, AlertTitle, AlertDescription, alertVariants } from './auth/components/ui/alert';
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from './auth/components/ui/card';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './auth/components/ui/dialog';
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './auth/components/ui/alert-dialog';
export { RadioGroup, RadioGroupItem } from './auth/components/ui/radio-group';

// Export all your shared components, utils, hooks, etc.
export const SharedButton: React.FC = () => {
  return <button>Click Me (Shared)</button>;
};

// Export useAuth hook
export { useAuth } from './auth/hooks/useAuth';

// Export AuthProvider

export { AuthProvider } from './auth/context/AuthContext'

// Export EmailModal component
export { default as EmailAuthModal } from './auth/components/EmailAuthModal';

//Export supabase object
export {supabase} from './auth/utils/supabase';

//Export auth error mapper
export {mapAuthError} from './auth/utils/authErrors';

//Export LoginUI

export {LoginUI} from './auth/components/LoginUI';

//Export ForgotPasswordForm

export {default as ForgotPasswordForm} from './auth/components/ForgotPassword';

//Export ForgotPasswordPage

export {default as ForgotPasswordPage} from './auth/pages/ForgotPasswordPage';

//Export ResetPasswordPage

export {default as ResetPasswordPage} from './auth/pages/ResetPasswordPage';