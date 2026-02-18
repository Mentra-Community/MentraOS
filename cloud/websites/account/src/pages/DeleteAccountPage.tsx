import React, { useState } from "react";
import DashboardLayout from "../components/DashboardLayout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@mentra/shared";

const DeleteAccountPage: React.FC = () => {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [reason, setReason] = useState<string>("");
  const [confirmText, setConfirmText] = useState<string>("");
  const [isConfirmationOpen, setIsConfirmationOpen] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const handleDeleteRequest = async () => {
    setIsConfirmationOpen(true);
  };

  const handleConfirmDelete = async () => {
    setIsProcessing(true);
    try {
      // This is a placeholder - in a real implementation, you would call your API
      // await api.account.requestDeletion(reason);
      console.log("Delete account requested with reason:", reason);

      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Sign out after account deletion
      await signOut();
      navigate("/login", { state: { accountDeleted: true } });
    } catch (error) {
      console.error("Failed to delete account:", error);
      setIsProcessing(false);
      setIsConfirmationOpen(false);
    }
  };

  const isDeleteButtonDisabled = reason.trim().length < 5;
  const isConfirmButtonDisabled = confirmText !== "DELETE";

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">
            Delete Your Account
          </h1>
        </div>

        <div className="grid grid-cols-1 gap-6">
          <Card className="border-red-200">
            <CardHeader>
              <CardTitle className="text-red-600">Delete Account</CardTitle>
              <CardDescription>
                Permanently delete your Mentra account and all associated data
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="p-4 bg-red-50 rounded-md">
                  <h3 className="text-sm font-medium text-red-800 mb-2">
                    Warning: This action cannot be undone
                  </h3>
                  <ul className="list-disc list-inside space-y-1 text-sm text-red-700">
                    <li>Your account profile will be permanently deleted</li>
                    <li>You will lose access to all your MentraOS apps</li>
                    <li>Your usage history and preferences will be deleted</li>
                    <li>Your device connections will be removed</li>
                    <li>This cannot be reversed</li>
                  </ul>
                </div>

                <div>
                  <Label htmlFor="reason">
                    Why are you deleting your account?
                  </Label>
                  <Textarea
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1"
                    placeholder="Please tell us why you're leaving so we can improve"
                    rows={3}
                  />
                </div>

                <div className="pt-4">
                  <Button
                    variant="destructive"
                    onClick={handleDeleteRequest}
                    disabled={isDeleteButtonDisabled || isProcessing}
                  >
                    {isProcessing ? "Processing..." : "Delete My Account"}
                  </Button>
                  <p className="text-xs text-gray-500 mt-2">
                    This will start the account deletion process
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Need Help?</CardTitle>
              <CardDescription>
                We're here to assist with any account issues
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm">
                  If you're experiencing issues with your account or have
                  concerns about your data, please contact our support team
                  before deleting your account.
                </p>
                <Button variant="outline" asChild>
                  <a href="mailto:help@mentra.glass">Contact Support</a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog
        open={isConfirmationOpen}
        onOpenChange={setIsConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Your account and all associated data
              will be permanently deleted.
              <div className="mt-4">
                <Label htmlFor="confirmText" className="text-sm font-medium">
                  Type <span className="font-bold">DELETE</span> to confirm
                </Label>
                <Input
                  id="confirmText"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="mt-1"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isConfirmButtonDisabled || isProcessing}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {isProcessing ? "Processing..." : "Permanently Delete Account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
};

export default DeleteAccountPage;
