# @mentra/workspace-ui

Shared React screens for Core workspaces: a picker, members, invitations, keys,
settings, an audit log and the invitation-accept page. The workspace portal and the admin
portal use it directly; the Developer Console vendors it. All of them call the same JSON
API, so the package only needs to know where that API is mounted.

It also holds the workspace portal's frame and controls, for any Mentra site that should
look like the portal: the sidebar shell, the workspace switcher, the brand marks, a
one-column layout, cards, dialogs, badges and form fields (see [Shell](#shell)).

A **workspace** is a group of people with permissions inside an organization (one Core
deployment). Roles are `member`, `developer`, `admin` and `owner`.

## Use

```tsx
import {QueryClient, QueryClientProvider} from "@tanstack/react-query"
import {createWorkspaceApi, WorkspaceMembersPanel, WorkspacePicker} from "@mentra/workspace-ui"

// "/api/portal/workspaces" in the workspace portal, "/api/admin/workspaces" in the admin portal.
const api = createWorkspaceApi({basePath: "/api/portal/workspaces"})
const queryClient = new QueryClient()

function Page({workspaceId, setWorkspaceId}: {workspaceId: string | null; setWorkspaceId(id: string): void}) {
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspacePicker api={api} value={workspaceId} onChange={setWorkspaceId} allowCreate />
      {workspaceId ? <WorkspaceMembersPanel api={api} workspaceId={workspaceId} /> : null}
    </QueryClientProvider>
  )
}
```

The components must render inside a `QueryClientProvider`. Query keys start with the
API's `basePath`, so two APIs can share one client without sharing data.

`react`, `react-dom` and `@tanstack/react-query` are peer dependencies: the site that
renders the screens provides them, so the screens and the site share one React and one
query client context. Only the `cloud-v2` workspace links this package; the root and
`sdk` workspaces exclude it (`!…/workspace-ui` in their `workspaces`). A package linked by
two installs resolves its peers from whichever install ran last, which would give the
screens a second React (and every hook a null dispatcher). Each site's
`shared-react.test.ts` checks that the screens and the site resolve the same copies.

| Export | What it is |
| --- | --- |
| `createWorkspaceApi({basePath, fetch?, credentials?})` | Typed client for every route; throws `WorkspaceApiError` |
| `WorkspacePicker` | Choose among your workspaces in a select; optionally create one inline |
| `CreateWorkspaceDialog` (`open`, `onClose`, `onCreated`), `CreateWorkspaceForm`, `useCreateWorkspace` | Create a workspace from just its name; the new workspace's detail is cached and the list refreshed |
| `WorkspaceMembersPanel` (`showUserIds?`) | Members (with a count), role changes, removal; `showUserIds` adds each member's copyable Mentra user id (for Organization Admins, who need it to recover ownership) |
| `WorkspaceInvitationsPanel` | Invite by email, and the pending invitations with Resend and Revoke, in one card |
| `WorkspaceInviteDialog` (`open`, `onClose`) | Invite by email and role in a dialog; the link is shown once after sending |
| `WorkspacePendingInvitationsPanel` | The pending invitations alone (Resend, Revoke), for a member page that invites through the dialog; renders nothing when none are pending |
| `WorkspaceCredentialsPanel` | The workspace's `msk_` keys; the token is shown once, with a copy button |
| `WorkspaceSettingsPanel` (`onDeleted?`, `onLeft?`) | Name and workspace ID (with copy), then a danger zone to leave or delete |
| `WorkspaceAuditPanel` | The workspace's audit log, paged: each event a sentence ("Changed priya@… from Member to Developer"), with the raw record behind Show details |
| `InvitationAcceptView` (`token`, `onAccepted(workspaceId)`, `onDismiss?`, `viewerEmail?`, `onSwitchAccount?`, `onGone?`) | What an invitation link opens; for someone else's invitation it says so and offers Switch account instead of Accept |
| `InvitationAcceptCard`, `useAcceptInvitation(api, {token} \| {invitationId}, …)`, `isInvitationForOtherAccount` | The same card for an invitation the host already has (one of `myInvitationsQuery`), and accepting it |
| `describeAuditEvent`, `plainText` | An audit event as a sentence, for other screens |
| `SecretDialog` (`name`, `token`, `onDone`) | The show-once dialog for a new credential, for other screens that mint one (the admin portal's operator keys) |
| `ConfirmButton` (`label`, `ariaLabel`, `prompt`, `confirmLabel`, `onConfirm`) | A destructive action behind an inline confirm step |
| `Button`, `buttonVariants`, `Input`, `Label`, `NativeSelect`, `Textarea` | Mentra's controls, for a host's own screens: one pill button system (`default`, `secondary`, `destructive-secondary`, `destructive`, `ghost`, `link`), pill inputs, native selects drawn to match, and a multi-line field drawn like the input |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | The bordered 24px card the panels sit in |
| `Dialog` (`open`, `onClose`, `title`, `description?`) | A modal on the platform's `<dialog>`; its content renders only while open |
| `Panel` (`title`, `description?`, `count?`, `actions?`) | A titled card for one panel's content, with a count beside the title and actions on the right |
| `Badge` (`tone?`) | A small chip: `outline` (the default, "You"), or filled `success` (green), `warn` (amber) or `neutral` (grey) for a status |
| `ErrorNotice` (`error`), `Loading`, `QueryGate` (`result`, `loadingLabel?`, `children(data)`) | An error in words in the amber notice, the spinner with what is loading, and a query's loading and failed-load states with Try again |
| `Avatar`, `WorkspaceAvatar`, `Count`, `Spinner` | A person's initials, a workspace's letter tile, a count beside a heading, the loading spinner |
| `AppShell`, `AccountFooter`, `WorkspaceSwitcher`, `SWITCHER_ITEM_CLASS` | The portal's frame, its account menu and its workspace switcher (see [Shell](#shell)) |
| `MentraMark`, `MentraLogo`, `BrandPage` (`title`) | The Mentra mark, the logo with its wordmark (inline SVG, no asset loader), and a page that is one card under the logo |
| `CenteredLayout` (`userEmail`, `onSignOut?`, `signingOut?`) | A page that is one focused task: the logo and Sign out across the top, one centered column |
| `useDismiss(ref, open, close)` | Closes a popover on a press outside `ref` or on Escape |
| `expiryFromDateInput` | The end of a `<input type="date">` day as an ISO string, or null |
| `effectiveRole`, `actsAsOrganizationAdmin`, `assignableRoles`, `can`, `ROLE_LABELS`, `ROLE_DESCRIPTIONS` | The capability helpers the panels use, whether an Organization Admin's powers go beyond their membership, and a one-line description of each role |
| `workspaceListQuery`, `workspaceDetailQuery`, `invitationPreviewQuery`, `myInvitationsQuery`, `workspaceKeys` | Query options and keys, for a host that shows the same data (a workspace switcher) |
| `errorMessage`, `isInvitationGone`, `isWorkspaceChangedError`, `WORKSPACE_CHANGED_MESSAGE` | Error text, whether an invitation can never be accepted, and the 409 handling |

## Behavior worth knowing

- **Controls follow capabilities.** Each panel reads `GET {basePath}/:workspaceId` and
  shows only what the viewer's capabilities allow. Role selectors offer exactly the
  transitions `canChangeRole` allows. The server still checks every request, so this is
  about not offering what would be refused, not about security.
- **Nobody changes their own role here.** The viewer's own row has no role selector, so
  one stray keystroke cannot demote an owner. Another owner or an Organization Admin
  changes it.
- **The viewer's role comes from their capabilities, not their membership.** An
  organization admin acts as an owner whether or not they are a member.
- **Stale views end in a refetch.** Changes carry the workspace revision the viewer last
  saw. On a 409 `membership_changed` the workspace is refetched and the panel says
  "This workspace changed. Review and try again."
- **Destructive actions ask twice**: removing a member, revoking a key or an
  invitation, leaving a workspace (an inline confirm step), and deleting one (type the
  workspace name). The only owner cannot leave: Leave is disabled and says why. A
  refused action says why next to its own control.
- **Resend is a new invitation.** It sends the same address the same role again; Core
  supersedes the pending invitation, so only the newest link works.
- **Dialogs are the platform's `<dialog>`**, opened with `showModal()`: the page behind is
  inert, focus stays inside, Escape and the backdrop close it. Their content renders only
  while open.
- **Secrets are shown once and never cached.** A credential's token and an invitation
  link live in the panel's state until dismissed. They are not in the query or mutation
  cache and never in API paths: invitation tokens travel in POST bodies. (The invitation
  link itself carries its token in the invitee's page URL, by design.) They stay on screen
  even if a background refetch fails: a failed refetch keeps the data already loaded, and
  only a query that has never loaded shows an error.
- **Credentials need a member who can publish.** Core ties a credential to its creator's
  membership, so the create form is shown only to members with the developer role or
  above. An organization admin outside the workspace can list and revoke but not create.

## Styling

The screens look like Mentra's sign-in page (`websites/account`): Red Hat Display, black and
grey pill buttons, pill inputs and selects, bordered 24px cards on a plain background,
the green focus ring, and amber and green notices. The tokens are defined once, in
`styles/mentra.css` (exported as `@mentra/workspace-ui/mentra.css`): the sign-in page's
palette as `--mentra-*` variables, mapped onto the shadcn theme names the components use
(`background`, `foreground`, `primary`, `secondary`, `muted`, `destructive`, `border`,
`ring`, …) plus brand names (`surface`, `hover`, `brand`, `info`, `error`), the card, menu
and notice radii, the dialog and menu shadows, the font and the focus ring.

The components are Tailwind v4 utility classes. In the stylesheet that imports Tailwind,
import the tokens and scan this package's sources (Tailwind only generates the classes it
finds):

```css
@import "tailwindcss";
@import "@mentra/workspace-ui/mentra.css";
@source "../node_modules/@mentra/workspace-ui/src";
```

The `@source` path is relative to that stylesheet (this one is for a stylesheet in
`src/`, next to `node_modules/`). The tokens load Red Hat Display from `/fonts`, so the
site serves the sign-in page's `public/fonts` (with its `OFL.txt`), keeps those URLs out
of the bundle (`external: ["/fonts/*"]` in `Bun.build`) and preloads both weights, as the
workspace portal's and the admin portal's `build.ts` do. Nothing is loaded from another
origin.

## Shell

`AppShell` is the workspace portal's frame: a 264px sidebar with the brand and a
switcher on top, the sections, links to other sites and the account at the bottom, a
sticky page header over the content, and on a phone the sidebar as a drawer behind a
menu button. It needs no `QueryClientProvider` and knows no router.

```tsx
import {AppShell, WorkspaceSwitcher, type ShellLinkComponent} from "@mentra/workspace-ui"
import {Link, useRouterState} from "@tanstack/react-router"

// The shell renders every in-app address through the host's link.
const ShellLink: ShellLinkComponent = ({href, ...props}) => <Link to={href} {...props} />

function ConsoleShell({children}: {children: React.ReactNode}) {
  const pathname = useRouterState({select: state => state.location.pathname})
  return (
    <AppShell
      brandTitle="Developer Console"
      brandSubtitle="MentraOS"
      linkComponent={ShellLink}
      switcher={
        <WorkspaceSwitcher
          current={active}
          workspaces={mine}
          invitations={[]}
          canCreate
          createNotice={null}
          onCreate={create}
          linkComponent={ShellLink}
        />
      }
      nav={[{key: "main", items: [{key: "apps", label: "Miniapps", icon: Boxes, href: "/apps"}]}]}
      active={item => item.href !== undefined && pathname.startsWith(item.href)}
      accountItems={[{key: "billing", label: "Billing", icon: CreditCard, href: "/billing"}]}
      title="Miniapps"
      userEmail={email}
      onSignOut={signOut}
    >
      {children}
    </AppShell>
  )
}
```

- **Items go somewhere by address or by action.** A section, an account-menu item or a
  switcher workspace has either an `href`, rendered with `linkComponent`, or an
  `onSelect`, rendered as a `<button>`. `links` (other sites) are always plain anchors
  that open a new tab.
- **The link component** gets an anchor's props with `href` (`ShellLinkProps`). It must
  render an `<a>` with them and call the given `onClick` before it navigates: the account
  menu closes itself in that `onClick`. Pass it to `AppShell` and to `WorkspaceSwitcher`;
  without one, items are plain anchors (`PlainLink`), so a click is a full page load.
- **The host says what is open.** `active(item)` marks the item `aria-current="page"` and
  fills it. Without it, nothing is marked.
- **Navigating closes the drawer and the menus.** A click on a link in the sidebar closes
  the mobile drawer; so does a click on a control marked `data-navigates`, which the
  shell puts on its own `onSelect` buttons. The switcher's menu closes the same way.
- **The switcher is presentational.** It takes the current workspace, the list (undefined
  while loading; `listFailed` and `onRetry` when it failed), the invitations as entries
  with the host's own actions, and whether Create workspace is offered. Choosing the
  current workspace's `onSelect` button only closes the menu. `extraItems` adds rows
  under the workspaces, above Create workspace: give each `role="menuitem"` and
  `SWITCHER_ITEM_CLASS`, so the arrow keys reach it and it matches.
- **Colours come from the tokens.** The shell uses only `mentra.css`'s theme names, so a
  site that imports it and scans this package's `src` (see [Styling](#styling)) gets the
  portal's look.

## Develop

```bash
cd cloud-v2
bun test packages/workspace-ui   # API client, panels and shell (server-rendered with seeded query data)
bun run typecheck                # tsc -b, which includes this package
```

`src/ui/` holds the controls (`button`, `card`, `dialog`, `input`, `label`,
`native-select`, `textarea`); the workspace portal uses them for its own screens too. The
panels use a native select because its options are real markup on the server and use
each platform's own picker. `src/shell/` holds the frame (`app-shell`,
`workspace-switcher`, `brand`, `centered-layout`, `link`, `use-dismiss`); the workspace
portal wires it in `websites/portal/src/components/portal-shell.tsx`.
