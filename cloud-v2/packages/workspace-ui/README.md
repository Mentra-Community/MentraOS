# @mentra/workspace-ui

Shared React screens for Core workspaces: a picker, members, invitations, credentials,
settings, an audit log and the invitation-accept page. The Core admin dashboard uses it
directly; the Developer Console vendors it. Both call the same JSON API, so the package
only needs to know where that API is mounted.

A **workspace** is a group of people with permissions inside an organization (one Core
deployment). Roles are `member`, `developer`, `admin` and `owner`.

## Use

```tsx
import {QueryClient, QueryClientProvider} from "@tanstack/react-query"
import {createWorkspaceApi, WorkspaceMembersPanel, WorkspacePicker} from "@mentra/workspace-ui"

// "/api/workspaces" on Core's admin dashboard, "/api/console/workspaces" behind the Store's console proxy.
const api = createWorkspaceApi({basePath: "/api/workspaces"})
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

| Export | What it is |
| --- | --- |
| `createWorkspaceApi({basePath, fetch?, credentials?})` | Typed client for every route; throws `WorkspaceApiError` |
| `WorkspacePicker` | Choose among your workspaces; optionally create one |
| `WorkspaceMembersPanel` | Members, role changes, removal |
| `WorkspaceInvitationsPanel` | Pending invitations, invite by email |
| `WorkspaceCredentialsPanel` | `msk_` credentials; the token is shown once, with a copy button |
| `WorkspaceSettingsPanel` (`onDeleted?`, `onLeft?`) | Rename, leave, delete |
| `WorkspaceAuditPanel` | The workspace's audit log, paged |
| `InvitationAcceptView` (`token`, `onAccepted(workspaceId)`) | What an invitation link opens |
| `SecretDialog` (`name`, `token`, `onDone`) | The show-once dialog for a new credential, for other screens that mint one (the admin dashboard's operator keys) |
| `ConfirmButton` (`label`, `ariaLabel`, `prompt`, `confirmLabel`, `onConfirm`) | A destructive action behind an inline confirm step |
| `expiryFromDateInput` | The end of a `<input type="date">` day as an ISO string, or null |
| `effectiveRole`, `assignableRoles`, `can`, `ROLE_LABELS` | The capability helpers the panels use |
| `errorMessage`, `isWorkspaceChangedError`, `WORKSPACE_CHANGED_MESSAGE` | Error text, and the 409 handling |

## Behavior worth knowing

- **Controls follow capabilities.** Each panel reads `GET {basePath}/:workspaceId` and
  shows only what the viewer's capabilities allow. Role selectors offer exactly the
  transitions `canChangeRole` allows. The server still checks every request, so this is
  about not offering what would be refused, not about security.
- **The viewer's role comes from their capabilities, not their membership.** An
  organization admin acts as an owner whether or not they are a member.
- **Stale views end in a refetch.** Changes carry the workspace revision the viewer last
  saw. On a 409 `membership_changed` the workspace is refetched and the panel says
  "This workspace changed. Review and try again."
- **Destructive actions ask twice**: removing a member, revoking a credential or an
  invitation, leaving a workspace (an inline confirm step), and deleting one (type the
  workspace name).
- **Secrets are shown once and never cached.** A credential's token and an invitation
  link live in the panel's state until dismissed. They are not in the query or mutation
  cache and not in any URL (invitation tokens travel in POST bodies). They stay on screen
  even if a background refetch fails: a failed refetch keeps the data already loaded, and
  only a query that has never loaded shows an error.
- **Credentials need a member who can publish.** Core ties a credential to its creator's
  membership, so the create form is shown only to members with the developer role or
  above. An organization admin outside the workspace can list and revoke but not create.

## Styling

The components are styled with Tailwind v4 utility classes and use the shadcn-style
theme tokens (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`,
`accent`, `destructive`, `border`, `input`, `ring`). Tailwind only generates
the classes it finds, so the consuming app must scan this package's sources. In the
stylesheet that imports Tailwind, add:

```css
@source "../node_modules/@mentra/workspace-ui/src";
```

The path is relative to that stylesheet (this one is for a stylesheet in `src/`, next to
`node_modules/`). The consumer provides the theme tokens, as the admin dashboard's
`styles/globals.css` does.

## Develop

```bash
cd cloud-v2
bun test packages/workspace-ui   # API client and panels (server-rendered with seeded query data)
bun run typecheck                # tsc -b, which includes this package
```

`src/ui/` holds copies of the admin dashboard's `button`, `card`, `input` and `label`
primitives (the Store cannot import the admin's own), plus a `native-select`. The panels
use a native select because its options are real markup on the server and use each
platform's own picker.
