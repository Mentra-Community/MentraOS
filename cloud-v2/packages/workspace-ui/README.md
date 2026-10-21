# @mentra/workspace-ui

Shared React screens for Core workspaces: a picker, members, invitations, keys,
settings, an audit log and the invitation-accept page. The workspace portal and the admin
portal use it directly; the Developer Console vendors it. All of them call the same JSON
API, so the package only needs to know where that API is mounted.

It also holds the workspace portal's Licenses page and the personal Billing page: the
views, their header actions, the cards, the buying dialogs, the billing client, and the
strings and formatting they are worded with (see [Licenses](#licenses)).

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
| `createBillingApi({locale, base?, fetch?, credentials?})`, `BillingApi` | Typed client for billing's `catalog`, `status`, `purchase` and `session`; every answer is parsed with the contract's schemas. `base` defaults to `/api/portal/billing`; `locale` rides on every request |
| `BillingScope`, `workspaceScope(id)`, `ACCOUNT_SCOPE`, `ownerTypeOf` | Whose billing a call is about: a workspace's, or the signed-in person's own |
| `BillingRefusedError`, `BillingUnavailableError`, `BillingContractError`, `billingErrorMessage` | A refusal billing worded with a code, a billing that could not answer, one that answered off-contract (`BillingContractError`, a `BillingUnavailableError` the queries do not retry), and the sentence for any |
| `WorkspacePicker` | Choose among your workspaces in a select; optionally create one inline |
| `CreateWorkspaceDialog` (`open`, `onClose`, `onCreated`), `CreateWorkspaceForm`, `useCreateWorkspace` | Create a workspace from just its name; the new workspace's detail is cached and the list refreshed |
| `WorkspaceMembersPanel` (`showUserIds?`, `licenses?`, `member?`, `onMemberChange?`, `locale?`) | Members (with a count) and a member panel for role changes and removal; `showUserIds` adds each member's copyable Mentra user id (for Organization Admins, who need it to recover ownership); `licenses` adds the Licenses column, selection and Assign licenses (see [Members' licenses](#members-licenses)) |
| `WorkspaceInvitationsPanel` | Invite by email, and the pending invitations with Resend and Revoke, in one card |
| `WorkspaceInviteDialog` (`open`, `onClose`) | Invite by email and role in a dialog; the link is shown once after sending |
| `WorkspacePendingInvitationsPanel` | The pending invitations alone (Resend, Revoke), for a member page that invites through the dialog; renders nothing when none are pending |
| `WorkspaceCredentialsPanel` | The workspace's `msk_` keys; the token is shown once, with a copy button |
| `WorkspaceSettingsPanel` (`onDeleted?`, `onLeft?`) | Name and workspace ID (with copy), then a danger zone to leave or delete |
| `WorkspaceAuditPanel` | The workspace's audit log, paged: each event a sentence ("Changed priya@… from Member to Developer"), with the raw record behind Show details |
| `WorkspaceLicensesView`, `WorkspaceLicensesHeaderActions` | The workspace's Licenses page, and the buttons for the title bar (Billing & invoices ↗, Buy a license); props in [Licenses](#licenses) |
| `PersonalBillingView`, `PersonalBillingHeaderActions` | The signed-in person's own Billing page, and its title-bar buttons |
| `LicenseCard` (`card`, `view`, `scope`, `billing`, `navigateOut`, `locale`, …) | One license: status badge, facts (Seats, Renews or Ends, Cost), the notices for a failed or unfinished payment, its seats, and a "…" menu for billing's other actions; `view` is `workspace`, `member` or `person` |
| `SeatStrip`, `SeatRoster`, `AvatarStack`, `PeoplePickerDialog`, `seatHolders` | A license's seats: the folded strip, the roster (Unassign, free seats, search past 8 holders), and the people picker that fills them; `seatHolders` names the holders |
| `CatalogGrid`, `CatalogDialog`, `BuyDialog`, `CatalogCard`, `canBuy` | Buying from billing's catalog: the grid an owner with nothing yet is offered, the "Buy a license" dialog, a workspace's seats step, and one product's card |
| `PurchaseBanner`, `TestModeBanner`, `LicensesSummary`, `LicensesUnavailable`, `PURCHASE_POLL_MS`, `PURCHASE_TIMEOUT_MS` | The banners and states around the cards, and the pace of the poll after checkout (2 seconds, for a minute) |
| `useHostedAction`, `HostedFeedback`, `NavigateOut`, `PortalTab` | How every ↗ button leaves the portal for a hosted page, its refusal in words, and the host's two ways out (see [Licenses](#licenses)) |
| `AssignLicensesDialog`, `MemberPanel`, `PersonLicenses`, `MembersLicenses` | The Members list's licenses: Assign licenses for the members chosen, the member panel (role, joining, Licenses, Remove), its Licenses switches, and the source `WorkspaceMembersPanel` takes (see [Members' licenses](#members-licenses)) |
| `ProductIcon`, `ProductChip`, `FeatureChips` | A product's look: its icon (a letter tile when it has none or it fails to load), icon and short name, and its feature chips (only with more than one feature) |
| `Notice`, `Fact`, `Skeleton`, `StatusBadge`, `HostedPageButton`, `isHeldLicense` | The pieces the cards are made of: a status notice (`warn`, `info`, `neutral`), a label and value for a `<dl>`, a loading bar, a badge, a button that leaves the portal (its ↗ is an icon, so its name is the label alone), and the guard for a card Core also lists |
| `joinLicenses`, `fitFor`, `seatCounts`, `holdsSeat`, `listedAction`, `catalogForOwner` | The page's logic, with no schemas at run time: Core's licenses joined to billing's entries and the catalog, in the page's order; what fits a license's free seats; and the rules that gate what is offered |
| `licenseStrings`, `refusalMessage` | Every sentence these pages show, in one module (see [Strings](#strings)) |
| `formatMoney`, `formatRecurrence`, `formatDay`, `formatDayShort`, `formatDate`, `priceLine`, `costFact`, `totalSummary`, `taxNote`, `renewalCadence`, `fitNote`, `holderNames`, `nameList`, `groupCardNumber` | Billing's typed values as text, in the portal's locale (see [Formatting](#formatting)) |
| `InvitationAcceptView` (`token`, `onAccepted(workspaceId)`, `onDismiss?`, `viewerEmail?`, `onSwitchAccount?`, `onGone?`) | What an invitation link opens; for someone else's invitation it says so and offers Switch account instead of Accept |
| `InvitationAcceptCard`, `useAcceptInvitation(api, {token} \| {invitationId}, …)`, `isInvitationForOtherAccount` | The same card for an invitation the host already has (one of `myInvitationsQuery`), and accepting it |
| `describeAuditEvent`, `plainText` | An audit event as a sentence, for other screens |
| `SecretDialog` (`name`, `token`, `onDone`) | The show-once dialog for a new credential, for other screens that mint one (the admin portal's operator keys) |
| `ConfirmButton` (`label`, `ariaLabel`, `prompt`, `confirmLabel`, `onConfirm`) | A destructive action behind an inline confirm step |
| `Button`, `buttonVariants`, `Input`, `Label`, `NativeSelect`, `Textarea` | Mentra's controls, for a host's own screens: one pill button system (`default`, `secondary`, `destructive-secondary`, `destructive`, `ghost`, `link`), pill inputs, native selects drawn to match, and a multi-line field drawn like the input |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | The bordered 24px card the panels sit in |
| `Dialog` (`open`, `onClose`, `title`, `description?`) | A modal on the platform's `<dialog>`; its content renders only while open |
| `SidePanel` (`open`, `onClose`, `title`, `description?`) | A modal `<dialog>` as a 30rem sheet from the right (full screen on a phone); the member panel is one |
| `Menu` (`label`, `trigger`, `items`, `align?`, `variant?`, `size?`) | A button that opens a list of `{key, label, onSelect, disabled?, destructive?}` items, with the keys a menu button has |
| `Stepper` (`value`, `onChange`, `min?`, `max?`, `label`, `decrementLabel`, `incrementLabel`) | A seat-count control: minus, an editable number and plus, and `onChange` only ever gets a whole number within the bounds |
| `Checkbox` (`label?`), `Switch`, `Meter` (`used`, `total`) | A styled native checkbox, a native switch, and the bar for seats used (dark up to the quantity, amber past it) |
| `Panel` (`title`, `description?`, `count?`, `actions?`) | A titled card for one panel's content, with a count beside the title and actions on the right |
| `Badge` (`tone?`) | A small chip: `outline` (the default, "You"), or filled `success` (green), `warn` (amber) or `neutral` (grey) for a status |
| `ErrorNotice` (`error`, `tone?`), `AlertText`, `Loading`, `QueryGate` (`result`, `loadingLabel?`, `tone?`, `children(data)`) | An error in words (amber, as the sign-in page's notice, or `tone="neutral"`), the spinner with what is loading, and a query's loading and failed-load states with Try again |
| `Avatar`, `WorkspaceAvatar`, `Count`, `Spinner` | A person's initials, a workspace's letter tile, a count beside a heading, the loading spinner |
| `AppShell`, `AccountFooter`, `WorkspaceSwitcher`, `SWITCHER_ITEM_CLASS` | The portal's frame, its account menu and its workspace switcher (see [Shell](#shell)) |
| `MentraMark`, `MentraLogo`, `BrandPage` (`title`) | The Mentra mark, the logo with its wordmark (inline SVG, no asset loader), and a page that is one card under the logo |
| `CenteredLayout` (`userEmail`, `onSignOut?`, `signingOut?`) | A page that is one focused task: the logo and Sign out across the top, one centered column |
| `useDismiss(ref, open, close)` | Closes a popover on a press outside `ref` or on Escape |
| `expiryFromDateInput` | The end of a `<input type="date">` day as an ISO string, or null |
| `effectiveRole`, `actsAsOrganizationAdmin`, `assignableRoles`, `can`, `ROLE_LABELS`, `ROLE_DESCRIPTIONS` | The capability helpers the panels use, whether an Organization Admin's powers go beyond their membership, and a one-line description of each role |
| `workspaceListQuery`, `workspaceDetailQuery`, `invitationPreviewQuery`, `myInvitationsQuery`, `workspaceKeys` | Query options and keys, for a host that shows the same data (a workspace switcher) |
| `billingCatalogQuery`, `billingStatusQuery`, `billingKeys`, `licensesQuery` | Query options and keys for billing's catalog and status and Core's licenses, for a host that shows the same data; a workspace's billing keys sit under `["workspace-ui", "billing", "workspace", id]` |
| `errorMessage`, `isInvitationGone`, `isWorkspaceChangedError`, `WORKSPACE_CHANGED_MESSAGE` | Error text, whether an invitation can never be accepted, and the 409 handling |
| `isLicenseChangedError` | Whether a seat change failed because the license changed under the caller (409 `no_seats_available`, 404 `license_not_found`) |

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

## Licenses

`WorkspaceLicensesView` is a workspace's Licenses page and `PersonalBillingView` is the
signed-in person's own Billing page. Each is composed from the cards, seats, dialogs and
banners in the table above, and each draws the page's content only. The title and
description belong to the host's frame (`licenseStrings.page` and `licenseStrings.personal`),
and so do the page's buttons: "Billing & invoices ↗" and "Buy a license" come as a second
component, `WorkspaceLicensesHeaderActions` or `PersonalBillingHeaderActions`, for the
frame's title bar.

```tsx
import {WorkspaceLicensesHeaderActions, WorkspaceLicensesView, createBillingApi} from "@mentra/workspace-ui"

// One client, made with the portal's locale; `api` is the workspace API from Use.
const billing = createBillingApi({locale})

// leavePortal and openPortalTab are the host's own (see NavigateOut below).
const shared = {
  api,
  billing,
  workspaceId,
  offer: {catalog: billingCatalogReadable, manage: viewerIsOfferedBilling},
  purchaseId: searchParams.get("purchase"),
  navigateOut: {leave: leavePortal, openTab: openPortalTab},
}

<Frame headerAction={<WorkspaceLicensesHeaderActions {...shared} />}>
  <WorkspaceLicensesView {...shared} onPurchaseDone={() => setQueryParam("purchase", null)} />
</Frame>

// PersonalBillingView and PersonalBillingHeaderActions take the same without `api`, `workspaceId` and `offer`.
```

### What a host supplies

- **A `QueryClientProvider`** above the views and the header actions. Both read through
  TanStack Query, and what a purchase or a seat change makes stale is refreshed in that
  cache.
- **The billing client**, one `createBillingApi({locale})`, as `billing`. It parses every
  answer with the contract, so an answer that does not match is a `BillingContractError`
  (an "unavailable" that is not retried, since it would only mismatch again), not a
  half-drawn page.
- **`NavigateOut {leave, openTab}`**, the host's only ways to take the browser to a hosted
  page; the package never sends the browser anywhere itself. What it does touch is the
  current page: it listens for `focus` and `visibilitychange` to read again after a page
  that does not return (below), and the purchase banner's Reload calls
  `window.location.reload()`.
  - `leave(url)` goes in this tab. It is only given an address the client already
    accepted (`https:`, or `http:` to `localhost` or `127.0.0.1`), and it is skipped when
    the card or dialog that asked has unmounted by the time its request answers, so keep
    the view and the header actions mounted while a request is out.
  - `openTab()` is called synchronously inside the click, and only for an action billing
    lists with `returns: false` (a page that does not send the person back). It returns
    `{go(url), close()}`, or null when the browser blocked the tab, and the view then offers
    an "Open the payment page ↗" link. A refused session closes the tab. `go` returns false
    when the person closed the blank tab while billing answered: that is not a failure, and
    the view offers the same link. (It throws for an address the host won't follow, and the
    view shows the generic refusal.)
  - After a page that does not return, the licenses and billing's status are read again
    whenever the window regains focus. That belongs to the page and not to the button that
    asked: closing the dialog or panel that started it does not end it. It ends at the first
    return after nothing on screen reads those answers any more, and starts nothing when
    nothing shows them already.
- **The locale.** The one `createBillingApi` was made with: billing words its content in
  it, and every date, amount and count is formatted in it (see [Formatting](#formatting)).
  `WorkspaceMembersPanel` takes it as `locale`.
- **`purchaseId` and `onPurchaseDone`.** `purchaseId` is the `?purchase=` a checkout came back
  with. Pass the same value to the view and its header actions: it is part of the status
  query's key, and sharing it is what makes the two read once. The view then polls billing's
  status and Core's licenses together every `PURCHASE_POLL_MS` until the purchase is ready
  and Core lists its license, for at most `PURCHASE_TIMEOUT_MS` (then the banner says
  "Your payment went through" with Reload, and the polling stops), or until the banner is
  dismissed. Dismiss calls `onPurchaseDone`, where the host removes `?purchase=`. Leave
  `pollMs` and `timeoutMs` unset; they are for tests.
- **`onRetry`** (workspace page, optional). Called when Retry is pressed on the unavailable
  page, after the view has read its own data again. A host re-reads what the view takes as
  given: the portal invalidates its `me`, so a page opened before billing was ready
  (`offer.catalog` false, with licenses to name) can recover.
- **`offer`** (workspace page only). `catalog` is whether billing's catalog can be read at
  all, and `manage` whether this viewer is offered billing for this workspace. Neither is
  decided here; the host knows them from its own `/me`.
- **The frame's words**, from `licenseStrings`: `page.title`, `page.description(name)` for
  someone who sees every license and `page.memberDescription(name)` for anyone else,
  `personal.title` and `personal.description`, and `nav.*` for the sidebar and account menu.

### What the pages show

- **The workspace page follows the viewer.**
  - An Admin or Owner who is offered billing (`offer.manage`) sees every license with its
    seats, dates, cost and billing's actions, the page total, the test-mode banner, and
    buying: "Buy a license", or the catalog itself while there are no licenses.
  - An Admin or Owner who is not offered billing sees every license with its seats and
    holders, and can assign and unassign. Billing is read for names only: no money, no
    billing buttons, no buying, and no request for the status.
  - A Member or Developer sees only the licenses they hold a seat in, as "You have a
    seat", with no totals, other people or controls, and no request for the status or the
    members. With none, the page says so.
- **Cards are keyed by license id and come in the page's order**: payment failed, payment
  incomplete, over-assigned, the license just bought (ringed in green, roster open), then by
  name. A billing entry Core has not received yet (a purchase still setting up) is a card
  without seats; on the personal page every card is like that.
- **A refetch never replaces the cards.** A page that has loaded keeps what is on screen
  through a refetch, and through one that fails. Billing's status keeps its last answer only
  while the key changes in its `purchase` (so removing `?purchase=` does not blank the page);
  another workspace, the account, another locale or another base path never carries anything
  over.
- **What cannot be read is "unavailable".** When Core's detail or licenses, the status for
  someone offered billing, or the catalog the page needs fails, the page says "Licenses are
  unavailable" (the personal page, "Billing is unavailable") with Retry, rather than
  drawing cards without names. A page asks for what its viewer needs and no more.
- **The header actions draw nothing until what they need has been read,** and nothing where
  there is nothing to act on or while the page says "unavailable", so the host mounts them
  unconditionally. A viewer who is not offered billing makes them ask for nothing at all.
  Each owns its "Buy a license" dialog and its "Billing & invoices ↗" request, and a refusal
  of that request shows in words under the buttons.
- **Every ↗ button goes through `useHostedAction`,** the Members screens' "Add seats ↗"
  included (see [Members' licenses](#members-licenses)). It marks the pressed
  button busy, words a refusal with one alert (`HostedFeedback`), and keeps the other
  buttons in the same card, dialog or grid disabled while a request is out. A purchase never
  opens a tab.
- **Seat changes mark billing's status stale** (assigning, unassigning, removing a member)
  so that a card's counts and costs are read again; the catalog and a role change leave it
  alone.
- **Prices and counts are billing's, not Core's.** Core adds no amounts: the page total is
  billing's own, and the one product computed is the Buy dialog's seats × unit price, and only
  for a per-seat price.

### Members' licenses

`WorkspaceMembersPanel` takes `licenses?: MembersLicenses`, the Members list's source for
everything about licenses. Leave it out where licenses are not shown (the admin portal).

```tsx
<WorkspaceMembersPanel
  api={api}
  workspaceId={workspaceId}
  locale={locale}
  licenses={{catalog: catalog?.products, billing: status?.licenses, billingApi: billing, navigateOut}}
  member={searchParams.get("member")}
  onMemberChange={id => setQueryParam("member", id)}
/>
```

- **`catalog`** is billing's `catalog.products`, or null or undefined while it cannot be
  read. Without it the Licenses column, the selection and the panel's Licenses section are
  all absent, and the rest of Members works.
- **`billing`** is `status.licenses`, where the viewer is offered billing. It decides
  whether "Add seats ↗" appears: a license offers it only when its entry lists `add_seats`,
  so with `billing` null, undefined or empty nothing offers it, and the sentences drop their
  "add seats" half.
- **`billingApi`** (the billing client, the same `createBillingApi` as the pages' `billing`)
  and **`navigateOut`** (the same `NavigateOut`) are how "Add seats ↗" works, not whether it
  appears. The screens run it through `useHostedAction`, with the panel's own `api` and the
  workspace's scope, like every other ↗ button: an `add_seats` action that returns leaves
  this tab, one billing lists with `returns: false` opens its tab in the click, a blocked
  tab becomes an "Open the payment page ↗" link, and a refusal is worded under the list
  (`HostedFeedback`), in the member panel and in Assign licenses alike. Both are required
  whenever a source is given.
- **With a source, for a viewer who can read licenses** in a workspace holding a license
  that has not ended, the list gains a Licenses column (a chip per license, "None",
  "After first sign-in", and three chips plus "+n" past four). With `workspace.licenses.assign`
  it also gains a checkbox per member who has signed in and the bar "n selected · Assign
  licenses", which opens `AssignLicensesDialog`: one row per license with the fit note
  ("2 of 5 seats free: enough for both."), and one request for every seat chosen.
- **The member panel** (`MemberPanel`) opens from a row: role, joining, Change role (exactly
  the roles `roleOptions` allows, never on one's own row), Remove from workspace (asks
  first), and a switch per license (`PersonLicenses`). Pass `member` and `onMemberChange` to
  let the host's address say which is open; leave both out and it keeps its own state.
- **Licenses keep Core's order here** (the order they were bought), not the Licenses page's,
  so chips, dialog rows and switches do not move when a payment fails.

### Strings

`strings/licenses.ts` is where every sentence these pages show lives: `licenseStrings`, and
`refusalMessage(code, {product?, scope?})` for billing's refusals. No component writes a
sentence of its own, so it is the one module a translation touches.

- **Each entry is a string, or a function of values already formatted.** Amounts and dates
  arrive formatted in the portal's locale, counts as numbers, and names as they are. A
  sentence with a part a screen styles comes back in parts (a notice's `{title, body}`, the
  summary's `{lead, rest}`), so no screen takes a sentence apart.
- **Billing's own content is shown as sent, never worded here:** product, feature and miniapp
  names, descriptions, and the `fallback*` labels. It arrives localized.
- **Nothing names the payment processor.** The strings test calls every function with sample
  arguments and scans each sentence for the processor's name, `undefined`, `NaN` and
  `[object`; a new function needs a `SAMPLES` entry or the test fails. The views' tests scan
  their text, labels and links for it too.
- **A refusal's code picks its sentence** (`already_licensed`, `checkout_in_progress`,
  `invalid_seats`, …); a code Core does not know gets "Billing couldn't do that. Try again."

### Formatting

`lib/billing-format.ts` and `lib/format.ts` turn billing's typed values into the values the
strings take, with `Intl`, in the portal's locale and the viewer's time zone.

- **Money** is `Intl.NumberFormat` in the currency's own digits (`amountMinor` is its minor
  unit). A whole amount drops its decimals ("$29", "29 €", "¥2,900"); one with a remainder
  keeps them ("$14.50", "KWD 1.500").
- **Counts** in "every 3 months" use `Intl.NumberFormat`, and the name sort that orders cards
  uses `Intl.Collator`, numeric and ignoring case and accents.
- **Dates** use `Intl.DateTimeFormat`: `formatDay` is "Nov 20, 2026" and `formatDayShort`,
  for a badge, is "Nov 20". The time zone is read on every call, not once at load, and a
  value that is not a date is shown as sent.
- **A locale `Intl` cannot use** falls back to `en-US` rather than throwing: a date or an
  amount must never be what fails a page.
- **Tax** is only what billing says: "before tax" for `excluded`, "including tax" for
  `included`, and nothing for `none` or a value Core does not know.

### Anything Core does not know is billing's label

Core words the statuses, price schemes and actions it knows, and shows billing's own label
for any other, so a newer billing never draws a blank or a wrong sentence.

- **A status** it does not know is the badge `fallbackStatusLabel`, in grey, and the card has
  no problem state and no special place in the order.
- **A price scheme** it does not know is the price's `fallbackLabel`, exactly, with no
  arithmetic: no "Renews every", no sum and no tax note. The Buy dialog's stepper stays,
  because billing still asked for a seat count.
- **An action** it does not know is billing's `label` in the card's "…" menu, with a ↗. A
  listed action with no notice to sit in goes there too, so nothing billing lists is lost.

The words are `licenseStrings.status.label(status, fallbackLabel, shortEndDate?)`,
`licenseStrings.actions.label(kind, fallbackLabel)` and `priceLine`/`costFact` in
`lib/billing-format.ts`.

### Controls

The new controls are native elements drawn in Mentra's styles, so the platform supplies the
tab order and Space.

- **`Checkbox` and `Switch`** are `<input type="checkbox">` (the switch with `role="switch"`)
  and take every input prop; `className` goes on the wrapper. Give `Checkbox` a `label` and
  the whole `<label>` (at least 24px high) is the click target and the accessible name;
  without one, put it in your own `<label>` or give it `aria-label`.
- **`Meter`** repeats what the text beside it says, so it is hidden from assistive technology.
- **`Stepper`** has no bare number field: the buttons turn off at a bound, ArrowUp and
  ArrowDown stop there, and the number is an editable spinbutton whose typed value is taken on
  blur or Enter and clamped (anything else reverts). The caller supplies the words.
- **`Menu`** opens on Enter, Space or a click with focus on the first item, and
  ArrowDown or ArrowUp on its button opens it on the first or last. In the list the arrows wrap and skip disabled items, Home
  and End jump, Tab closes, and an outside press closes. Escape closes, returns focus to the
  button and stops there, so a panel around the menu stays open. Choosing an item closes the
  menu and refocuses the button before it runs `onSelect`.
- **`SidePanel`** is a modal `<dialog>` like `Dialog`: its content renders only while open,
  focus goes inside on open and back to the opener on close, and Tab and Shift+Tab wrap
  among the controls that can be reached (not disabled, hidden, `inert` or `tabindex="-1"`
  ones). Escape, ×, a backdrop click and the native `cancel` each call `onClose` once; the
  host owns `open`. Keys from a dialog nested inside it are left to that dialog.
- **`Notice`** is `role="status"` in every tone, because nothing on these pages interrupts
  the person. A failed action's message is an `ErrorNotice`, the alert.
- **Amber is for payments.** On the Licenses page, the Members list and its panel, and the
  personal Billing page, amber marks a failed or incomplete payment and over-assignment, and
  nothing else (the spec's rule; test mode's hazard tape is the design's). So every failure and
  refusal there, billing's included, is an alert in the neutral notice style
  (`tone="neutral"`: the surface of a plain `Notice`, no new token). `AlertText`, `ErrorNotice`
  and `QueryGate` stay amber by default, as the sign-in page's notice, for the panels outside
  these pages (invitations, credentials, settings, audit).
- **`HostedPageButton`** shows a ↗ icon, not a character, so its name is the label alone
  ("Add seats"). A hidden hint, "Opens a secure billing page" (or "… in a new tab"),
  describes it to a screen reader.

## Develop

```bash
cd cloud-v2
bun test packages/workspace-ui   # API client, panels, shell and Licenses pages (server-rendered with seeded query data, or in a DOM)
bun run typecheck                # tsc -b, which includes this package
```

`src/ui/` holds the controls (`button`, `card`, `checkbox`, `dialog`, `input`, `label`,
`menu`, `meter`, `native-select`, `side-panel`, `stepper`, `switch`, `textarea`); the
workspace portal uses them for its own screens too. The panels use a native select because
its options are real markup on the server and use each platform's own picker. `src/shell/`
holds the frame (`app-shell`, `workspace-switcher`, `brand`, `centered-layout`, `link`,
`use-dismiss`); the workspace portal wires it in
`websites/portal/src/components/portal-shell.tsx`.

`src/components/licenses/` holds the Licenses pages and their pieces (`licenses-view`,
`personal-billing-view`, `license-card`, `seats`, `people-picker`, `catalog`,
`assign-licenses`, `banners`, `hosted-action`, `parts`, `product`); `src/strings/licenses.ts`
holds every sentence they show, and `src/lib/` the formatting (`billing-format`, `format`)
and the join (`license-join`). Tests for the DOM use `src/test-dom.tsx` (happy-dom, with
`act` around every helper). It is for tests only: the package exports it as the subpath
`@mentra/workspace-ui/test-dom`, so a host's own DOM tests (the workspace portal's) use the
same DOM and the same React as the components, and no host app imports it.

Billing's client is `billing-api.ts`, and the scope and error types it re-exports live in
`billing-scope.ts` and `billing-errors.ts`, which carry no schemas. The query layer, the
join, the product chips, and the Members panel with its member panel and Assign licenses
dialog import only those, never `billing-api.ts` or the contract's `portal-billing` (the
icon rule comes from `@mentra/workspace-contract/portal-billing-icons`, which carries no
schemas either), so the admin portal's bundle takes no zod from them. A test per module
follows its runtime imports to keep it so. The buying components take the client as a prop
and never import `billing-api.ts`, so the host brings it.
