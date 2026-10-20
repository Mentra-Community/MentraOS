export { createWorkspaceApi } from "./api";
export type {
  AcceptedInvitation,
  AuditPage,
  CreateCredentialInput,
  CreatedCredential,
  CreatedInvitation,
  FetchLike,
  InvitationPreview,
  WorkspaceApi,
  WorkspaceListItem,
} from "./api";
export {
  errorMessage,
  isInvitationGone,
  isWorkspaceChangedError,
  isWorkspaceHeldError,
  WORKSPACE_CHANGED_MESSAGE,
  WorkspaceApiError,
} from "./errors";
export {
  invitationPreviewQuery,
  licensesQuery,
  myInvitationsQuery,
  workspaceDetailQuery,
  workspaceKeys,
  workspaceListQuery,
} from "./queries";
export { actsAsOrganizationAdmin, assignableRoles, can, effectiveRole, ROLE_DESCRIPTIONS, ROLE_LABELS } from "./roles";

export { WorkspaceAuditPanel } from "./components/audit-panel";
export {
  Avatar,
  Badge,
  ConfirmButton,
  CopyButton,
  Count,
  ErrorNotice,
  initials,
  Loading,
  Panel,
  QueryGate,
  Spinner,
  WorkspaceAvatar,
  type BadgeTone,
} from "./components/common";
export { CreateWorkspaceDialog, CreateWorkspaceForm, useCreateWorkspace } from "./components/create-workspace";
export { expiryFromDateInput, SecretDialog, WorkspaceCredentialsPanel } from "./components/credentials-panel";
export {
  acceptErrorMessage,
  InvitationAcceptCard,
  InvitationAcceptView,
  isInvitationForOtherAccount,
  useAcceptInvitation,
  type InvitationLoad,
  type InvitationRef,
} from "./components/invitation-accept-view";
export { describeAuditEvent, plainText, type AuditDescription, type AuditText } from "./lib/audit";
export {
  WorkspaceInvitationsPanel,
  WorkspaceInviteDialog,
  WorkspacePendingInvitationsPanel,
} from "./components/invitations-panel";
export { productLabel, WorkspaceLicensesPanel } from "./components/licenses-panel";
export { WorkspaceMembersPanel } from "./components/members-panel";
export { WorkspacePicker } from "./components/workspace-picker";
export { WorkspaceSettingsPanel } from "./components/settings-panel";

// Mentra's controls, for a host's own screens: one button system, inputs and selects (styles/mentra.css).
export { Button, buttonVariants } from "./ui/button";
export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card";
export { Dialog } from "./ui/dialog";
export { Input } from "./ui/input";
export { Label } from "./ui/label";
export { NativeSelect } from "./ui/native-select";
export { Textarea } from "./ui/textarea";

// The portal's frame, for any Mentra site: the sidebar shell, the workspace switcher, the brand marks
// and the one-column layout. None of it knows a router: links go through the host's link component.
export {
  AccountFooter,
  AppShell,
  type AppShellProps,
  type ExternalNavItem,
  type NavGroup,
  type NavItem,
} from "./shell/app-shell";
export { BrandPage, MentraLogo, MentraMark } from "./shell/brand";
export { CenteredLayout } from "./shell/centered-layout";
export {
  PlainLink,
  type ShellIcon,
  type ShellLinkComponent,
  type ShellLinkProps,
  type ShellTarget,
} from "./shell/link";
export { useDismiss } from "./shell/use-dismiss";
export {
  SWITCHER_ITEM_CLASS,
  WorkspaceSwitcher,
  type SwitcherCurrent,
  type SwitcherInvitation,
  type SwitcherWorkspace,
} from "./shell/workspace-switcher";
