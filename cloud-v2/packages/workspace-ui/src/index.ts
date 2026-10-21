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
  isLicenseChangedError,
  isWorkspaceChangedError,
  isWorkspaceHeldError,
  WORKSPACE_CHANGED_MESSAGE,
  WorkspaceApiError,
} from "./errors";
export {
  billingCatalogQuery,
  billingKeys,
  billingStatusQuery,
  invitationPreviewQuery,
  licensesQuery,
  myInvitationsQuery,
  workspaceDetailQuery,
  workspaceKeys,
  workspaceListQuery,
} from "./queries";
// Billing's data, as the Licenses and Billing pages read it: the client (every answer parsed with the contract), the
// sentences Core words it with, and the formatting in the portal's locale and the viewer's time zone.
export {
  ACCOUNT_SCOPE,
  BillingRefusedError,
  BillingUnavailableError,
  billingErrorMessage,
  createBillingApi,
  ownerTypeOf,
  workspaceScope,
  type BillingApi,
  type BillingScope,
} from "./billing-api";
export { licenseStrings, refusalMessage, type LicenseScope, type LicenseStrings, type RefusalContext } from "./strings/licenses";
export {
  costFact,
  fitNote,
  formatDay,
  formatDayShort,
  formatMoney,
  formatRecurrence,
  groupCardNumber,
  holderNames,
  nameList,
  priceLine,
  renewalCadence,
  taxNote,
  totalSummary,
  type CostFact,
} from "./lib/billing-format";
export { formatDate } from "./lib/format";
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

// Mentra's controls, for a host's own screens: one button system, inputs, selects, checkboxes, switches, a stepper, a menu and a side panel (styles/mentra.css).
export { Button, buttonVariants } from "./ui/button";
export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card";
export { Checkbox } from "./ui/checkbox";
export { Dialog } from "./ui/dialog";
export { Input } from "./ui/input";
export { Label } from "./ui/label";
export { Menu, type MenuItem } from "./ui/menu";
export { Meter } from "./ui/meter";
export { NativeSelect } from "./ui/native-select";
export { SidePanel } from "./ui/side-panel";
export { Stepper } from "./ui/stepper";
export { Switch } from "./ui/switch";
export { Textarea } from "./ui/textarea";

// The pieces the Licenses and Billing screens are made of.
export { Fact, HostedPageButton, Notice, Skeleton, StatusBadge, type StatusBadgeStatus } from "./components/licenses/parts";

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

// A product's look (its icon, chip and feature chips), and the cards of the Licenses page: Core's licenses, billing's
// status and its catalog joined and put in order, with the seat counts and what fits a license's free seats.
export { FeatureChips, ProductChip, ProductIcon, type ProductIdentity } from "./components/licenses/product";
export {
  catalogForOwner,
  fitFor,
  holdsSeat,
  joinLicenses,
  listedAction,
  seatCounts,
  type FitKind,
  type JoinedLicense,
  type JoinInput,
  type LicenseFit,
  type LicenseProblem,
  type SeatCounts,
} from "./lib/license-join";

// The Licenses page's cards: a license with its seats, the people picker that fills them, and the banners and
// states around them. `useHostedAction` is how every ↗ button leaves the portal, including the catalog's (`NavigateOut`
// is the host's side).
export { LicenseCard, type LicenseCardProps, type LicenseCardView } from "./components/licenses/license-card";
export {
  HostedFeedback,
  useHostedAction,
  type ActionRequest,
  type HostedAction,
  type HostedBilling,
  type HostedRequest,
  type NavigateOut,
  type PortalTab,
  type PurchaseRequest,
} from "./components/licenses/hosted-action";
export { AvatarStack, PersonLabel, SeatRoster, SeatStrip, seatHolders, type AddSeatsControl, type SeatHolder } from "./components/licenses/seats";
export { PeoplePickerDialog } from "./components/licenses/people-picker";
export {
  LicensesSummary,
  LicensesUnavailable,
  PURCHASE_POLL_MS,
  PURCHASE_TIMEOUT_MS,
  PurchaseBanner,
  TestModeBanner,
} from "./components/licenses/banners";
// Buying from billing's catalog: the grid an owner with nothing yet is offered, the "Buy a license" dialog, and the
// seats step. Each takes billing's client and the host's `navigateOut`, and sends the browser to a hosted page.
export {
  BuyDialog,
  canBuy,
  CatalogCard,
  CatalogDialog,
  CatalogGrid,
  type BuyableEntry,
  type BuyDialogProps,
  type BuyingHost,
  type CatalogBilling,
  type CatalogCardProps,
  type CatalogProps,
} from "./components/licenses/catalog";
// The Members list's licenses: the member panel (role, joining, Licenses, Remove), its Licenses section, and Assign
// licenses for the members chosen in the list. `WorkspaceMembersPanel` takes a `MembersLicenses` source to show them.
export { AssignLicensesDialog, type AssignLicensesDialogProps } from "./components/licenses/assign-licenses";
export { MemberPanel, PersonLicenses, type MemberPanelProps, type PersonLicensesProps } from "./components/member-panel";
export type { MembersLicenses } from "./components/members-panel";
