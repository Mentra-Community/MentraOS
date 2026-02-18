import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Mail, UserPlus, AlertCircle, CheckCircle2, Loader2, Shield, User, UserCog, AlertTriangle, LogOut } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import api, { OrgMember, OrgRole, PendingInvite } from '@/services/api.service';
import { useOrganization } from '@/context/OrganizationContext';
import { toast } from 'sonner';
import { useOrgPermissions } from '@/hooks/useOrgPermissions';
import { useAuth } from '@mentra/shared';

/**
 * Members page for managing organization members
 * Allows inviting new members and changing roles of existing members
 */
const Members: React.FC = () => {
  const { currentOrg, refreshOrgs } = useOrganization();
  const { isAdmin, loading: permissionsLoading } = useOrgPermissions();
  const { user } = useAuth();

  // Member list state
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [isInviting, setIsInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(false);

  // Load members when organization changes
  useEffect(() => {
    fetchMembers();
  }, [currentOrg?.id]);

  // Fetch members list
  const fetchMembers = async () => {
    if (!currentOrg) {
      setLoadingMembers(false);
      return;
    }

    try {
      setLoadingMembers(true);
      setError(null);

      const orgDetails = await api.orgs.get(currentOrg.id);
      setMembers(orgDetails.members);
      setPendingInvites(orgDetails.pendingInvites || []);
    } catch (err) {
      console.error('Error fetching members:', err);
      setError('Failed to load organization members');
      toast.error('Failed to load members');
    } finally {
      setLoadingMembers(false);
    }
  };

  // Handle member role change
  const handleRoleChange = async (memberId: string, newRole: OrgRole) => {
    if (!currentOrg) return;

    try {
      await api.orgs.changeRole(currentOrg.id, memberId, newRole);
      await fetchMembers();
      toast.success('Member role updated');
    } catch (err) {
      console.error('Error changing role:', err);
      toast.error('Failed to update member role');
    }
  };

  // Handle member removal
  const handleRemoveMember = async (memberId: string) => {
    if (!currentOrg) return;

    if (!confirm('Are you sure you want to remove this member from the organization?')) {
      return;
    }

    try {
      await api.orgs.removeMember(currentOrg.id, memberId);
      await fetchMembers();
      toast.success('Member removed from organization');
    } catch (err) {
      console.error('Error removing member:', err);
      toast.error('Failed to remove member');
    }
  };

  /**
   * Check if there are other admins in the organization besides the current user
   */
  const hasOtherAdmins = (): boolean => {
    const currentUserEmail = user?.email?.toLowerCase();
    const otherAdmins = members.filter(
      member =>
        member.role === 'admin' &&
        member.user.email.toLowerCase() !== currentUserEmail
    );
    return otherAdmins.length > 0;
  };

  /**
   * Handle current user leaving the organization
   */
  const handleLeaveOrganization = async () => {
    if (!currentOrg || !user) return;

    const currentUserMember = members.find(
      member => member.user.email.toLowerCase() === user.email?.toLowerCase()
    );

    if (!currentUserMember) return;

    // Check if user is an admin and there are no other admins
    if (currentUserMember.role === 'admin' && !hasOtherAdmins()) {
      toast.error('You cannot leave the organization as you are the only admin. Please promote another member to admin first.');
      return;
    }

    const confirmMessage = currentUserMember.role === 'admin'
      ? 'Are you sure you want to leave this organization? You will lose admin access and will need to be re-invited to rejoin.'
      : 'Are you sure you want to leave this organization? You will need to be re-invited to rejoin.';

    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      await api.orgs.removeMember(currentOrg.id, currentUserMember.user.id);
      toast.success('You have left the organization');

      // Refresh the organization list since the user is no longer part of this org
      await refreshOrgs();
    } catch (err) {
      console.error('Error leaving organization:', err);
      toast.error('Failed to leave organization');
    }
  };

  // Handle resending an invitation
  const handleResendInvite = async (email: string) => {
    if (!currentOrg) return;

    try {
      await api.orgs.resendInvite(currentOrg.id, email);
      toast.success(`Invitation resent to ${email}`);
      await fetchMembers(); // Refresh to update emailSentCount
    } catch (err) {
      console.error('Error resending invite:', err);
      toast.error('Failed to resend invitation');
    }
  };

  // Handle rescinding an invitation
  const handleRescindInvite = async (email: string) => {
    if (!currentOrg) return;

    if (!confirm(`Are you sure you want to cancel the invitation to ${email}?`)) {
      return;
    }

    try {
      await api.orgs.rescindInvite(currentOrg.id, email);
      await fetchMembers();
      toast.success('Invitation cancelled');
    } catch (err) {
      console.error('Error rescinding invite:', err);
      toast.error('Failed to cancel invitation');
    }
  };

  // Handle invite submission
  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentOrg) {
      setError('No organization selected');
      return;
    }

    // Validate email
    if (!inviteEmail || !inviteEmail.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setIsInviting(true);
    setError(null);
    setInviteSuccess(false);

    try {
      await api.orgs.invite(currentOrg.id, inviteEmail, inviteRole);

      // Show success message and reset form
      setInviteSuccess(true);
      setInviteEmail('');
      setInviteRole('member');

      toast.success(`Invitation sent to ${inviteEmail}`);

      // Refresh members to show pending invite
      await fetchMembers();

      // Reset success after 3 seconds
      setTimeout(() => {
        setInviteSuccess(false);
      }, 3000);
    } catch (err) {
      console.error('Error sending invite:', err);
      setError('Failed to send invitation. Please try again.');
      toast.error('Failed to send invitation');
    } finally {
      setIsInviting(false);
    }
  };

  // Render role icon based on role
  const RoleIcon = ({ role }: { role: OrgRole }) => {
    switch (role) {
      case 'admin':
        return <UserCog className="h-4 w-4 text-blue-600" />;
      default:
        return <User className="h-4 w-4 text-gray-600" />;
    }
  };

  // If no organization is selected
  if (!currentOrg) {
    return (
      <DashboardLayout>
        <div className="max-w-5xl mx-auto">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-2xl">Organization Members</CardTitle>
              <CardDescription>No organization selected</CardDescription>
            </CardHeader>
            <CardContent>
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  You don't have an active organization. Please create or join an organization first.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Member list */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl">Organization Members</CardTitle>
            <CardDescription>
              {isAdmin
                ? `Manage members of ${currentOrg?.name}`
                : `Members of ${currentOrg?.name} (read-only view)`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingMembers || permissionsLoading ? (
              <div className="p-8 text-center">
                <div className="animate-spin mx-auto h-8 w-8 border-t-2 border-b-2 border-blue-500 rounded-full"></div>
                <p className="mt-2 text-gray-500">Loading members...</p>
              </div>
            ) : (
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Joined</TableHead>
                      {isAdmin && <TableHead className="text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.length === 0 && pendingInvites.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={isAdmin ? 4 : 3} className="text-center py-4 text-gray-500">
                          No members found
                        </TableCell>
                      </TableRow>
                    ) : (
                      <>
                        {members.map((member) => (
                          <TableRow key={member.user.id}>
                            <TableCell>{member.user.email}</TableCell>
                            <TableCell className="flex items-center gap-1">
                              <RoleIcon role={member.role} />
                              {isAdmin ? (
                                // Prevent modifying your own role
                                user?.email?.toLowerCase() === member.user.email.toLowerCase() ? (
                                  <div className="ml-2 flex items-center">
                                    <span className="capitalize text-sm">{member.role}</span>
                                  </div>
                                ) : (
                                  <Select
                                    value={member.role}
                                    onValueChange={(value: OrgRole) => handleRoleChange(member.user.id, value)}
                                  >
                                    <SelectTrigger className="w-32">
                                      <SelectValue placeholder={member.role} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="admin">Admin</SelectItem>
                                      <SelectItem value="member">Member</SelectItem>
                                    </SelectContent>
                                  </Select>
                                )
                              ) : (
                                <span className="ml-2 capitalize text-sm">{member.role}</span>
                              )}
                            </TableCell>
                            <TableCell>{new Date(member.joinedAt).toLocaleDateString()}</TableCell>
                            {isAdmin && (
                              <TableCell className="text-right">
                                {user?.email?.toLowerCase() === member.user.email.toLowerCase() ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={member.role === 'admin' && !hasOtherAdmins()}
                                    title={
                                      member.role === 'admin' && !hasOtherAdmins()
                                        ? "You cannot leave as you are the only admin. Promote another member to admin first."
                                        : "Leave this organization"
                                    }
                                    onClick={handleLeaveOrganization}
                                  >
                                    <LogOut className="mr-2 h-4 w-4" />
                                    Leave
                                  </Button>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleRemoveMember(member.user.id)}
                                  >
                                    Remove
                                  </Button>
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                        {/* Pending invitations */}
                        {pendingInvites.map((invite) => (
                          <TableRow key={invite.email} className="bg-gray-50">
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {invite.email}
                                <span className="text-xs text-gray-500">(pending)</span>
                              </div>
                            </TableCell>
                            <TableCell className="flex items-center gap-1">
                              <RoleIcon role={invite.role} />
                              <span className="ml-2 capitalize text-sm">{invite.role}</span>
                            </TableCell>
                            <TableCell>
                              <div>
                                <div className="text-sm">Invited {new Date(invite.invitedAt).toLocaleDateString()}</div>
                                <div className="text-xs text-gray-500">
                                  {invite.emailSentCount > 1 && `Resent ${invite.emailSentCount - 1} time${invite.emailSentCount > 2 ? 's' : ''}`}
                                  {new Date(invite.expiresAt) < new Date() && (
                                    <span className="text-red-500 ml-2">Expired</span>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            {isAdmin && (
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-2">
                                  {new Date(invite.expiresAt) > new Date() && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleResendInvite(invite.email)}
                                    >
                                      Resend
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleRescindInvite(invite.email)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Only show the invite form for admins */}
        {isAdmin && (
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl">Invite New Member</CardTitle>
              <CardDescription>
                Send an invitation to join your organization
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleInvite} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {inviteSuccess && (
                  <Alert className="bg-green-50 text-green-800 border-green-200">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-700">
                      Invitation sent successfully!
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="inviteEmail" className="flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Email Address
                  </Label>
                  <Input
                    id="inviteEmail"
                    type="email"
                    placeholder="colleague@example.com"
                    value={inviteEmail}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.currentTarget.value)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="inviteRole" className="flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    Role
                  </Label>
                  <Select value={inviteRole} onValueChange={(value: OrgRole) => setInviteRole(value)}>
                    <SelectTrigger id="inviteRole" className="w-full">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin (full control)</SelectItem>
                      <SelectItem value="member">Member (manage apps)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500">
                    {inviteRole === 'admin' && 'Admins have full control over the organization, including managing members and apps.'}
                    {inviteRole === 'member' && 'Members can manage apps, but cannot manage the organization or its members.'}
                  </p>
                </div>

                <div className="flex justify-end pt-2">
                  <Button type="submit" disabled={isInviting}>
                    {isInviting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <UserPlus className="mr-2 h-4 w-4" />
                        Send Invitation
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
};

export default Members;