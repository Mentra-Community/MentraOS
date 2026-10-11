# @mentra/workspace-ui

Shared React screens for Core workspaces: a picker, members, invitations, credentials,
settings, an audit log and the invitation-accept page. The workspace portal and the admin
portal use it directly; the Developer Console vendors it. All of them call the same JSON
API, so the package only needs to know where that API is mounted.

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
| `WorkspaceCredentialsPanel` | `msk_` credentials; the token is shown once, with a copy button |
| `WorkspaceSettingsPanel` (`onDeleted?`, `onLeft?`) | Name and workspace ID (with copy), then a danger zone to leave or delete |
| `WorkspaceAuditPanel` | The workspace's audit log, paged |
| `InvitationAcceptView` (`token`, `onAccepted(workspaceId)`, `onDismiss?`) | What an invitation link opens |
| `SecretDialog` (`name`, `token`, `onDone`) | The show-once dialog for a new credential, for other screens that mint one (the admin portal's operator keys) |
| `ConfirmButton` (`label`, `ariaLabel`, `prompt`, `confirmLabel`, `onConfirm`) | A destructive action behind an inline confirm step |
| `Button`, `buttonVariants`, `Input`, `Label`, `NativeSelect` | Mentra's controls, for a host's own screens: one pill button system (`default`, `secondary`, `destructive-secondary`, `destructive`, `ghost`, `link`), pill inputs, and native selects drawn to match |
| `Avatar`, `WorkspaceAvatar`, `Count`, `Spinner` | A person's initials, a workspace's letter tile, a count beside a heading, the loading spinner |
| `expiryFromDateInput` | The end of a `<input type="date">` day as an ISO string, or null |
| `effectiveRole`, `assignableRoles`, `can`, `ROLE_LABELS`, `ROLE_DESCRIPTIONS` | The capability helpers the panels use, and a one-line description of each role |
| `workspaceListQuery`, `workspaceDetailQuery`, `invitationPreviewQuery`, `workspaceKeys` | Query options and keys, for a host that shows the same data (a workspace switcher) |
| `errorMessage`, `isWorkspaceChangedError`, `WORKSPACE_CHANGED_MESSAGE` | Error text, and the 409 handling |

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
- **Destructive actions ask twice**: removing a member, revoking a credential or an
  invitation, leaving a workspace (an inline confirm step), and deleting one (type the
  workspace name).
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

## Develop

```bash
cd cloud-v2
bun test packages/workspace-ui   # API client and panels (server-rendered with seeded query data)
bun run typecheck                # tsc -b, which includes this package
```

`src/ui/` holds the controls (`button`, `card`, `dialog`, `input`, `label`,
`native-select`); the workspace portal uses them for its own screens too. The panels use
a native select because its options are real markup on the server and use each
platform's own picker.
