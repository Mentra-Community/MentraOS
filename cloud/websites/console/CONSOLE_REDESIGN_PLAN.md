# Developer Console Redesign Plan

## Executive Summary

This document outlines the implementation plan for redesigning the MentraOS Developer Console based on the ticket requirements. The changes span terminology updates, UX improvements, logical grouping, new features, and styling upgrades.

---

## Clarified Requirements

| Question | Answer |
|----------|--------|
| Docs base URL | `docs.mentraglass.com` (Mintlify-powered, source in `/docs`) |
| Server URL verification | HTTP reachability check, hit `/health` endpoint |
| Onboarding Instructions | Remove from frontend entirely |
| Webview URL toggle | When OFF, send `${serverUrl}/webview` to backend (all apps have a webview) |
| Store Guidelines | Placeholder content, hosted on console (not docs) |
| Dark mode | Future-proof architecture, not required for this iteration |

---

## Documentation Links Reference

Based on `/docs/docs.json`, here are the existing docs pages we can link to:

| Console Section | Docs Page Path | Full URL |
|-----------------|----------------|----------|
| Server URL / Local Dev | `app-devs/getting-started/deployment/local-development` | `docs.mentraglass.com/app-devs/getting-started/deployment/local-development` |
| Webviews | `app-devs/core-concepts/webviews/react-webviews` | `docs.mentraglass.com/app-devs/core-concepts/webviews/react-webviews` |
| Permissions | `app-devs/core-concepts/permissions` | `docs.mentraglass.com/app-devs/core-concepts/permissions` |
| Hardware Requirements | `app-devs/core-concepts/hardware-capabilities/overview` | `docs.mentraglass.com/app-devs/core-concepts/hardware-capabilities/overview` |
| AI Tools (Mira) | `app-devs/core-concepts/mira-tool-calls` | `docs.mentraglass.com/app-devs/core-concepts/mira-tool-calls` |
| Example Apps | `app-devs/getting-started/example-apps` | `docs.mentraglass.com/app-devs/getting-started/example-apps` |

**Note:** The ticket mentions updating the example-apps page to have links to "Webview Example" and "Mira Tools" sections - this is a docs change, not console.

---

## Current State Analysis

### File Structure
```
src/pages/
├── CreateApp.tsx (690 lines) → CreateMiniApp.tsx
├── EditApp.tsx (1582 lines) → EditMiniApp.tsx
├── AppList.tsx → MiniAppList.tsx
└── ...

src/components/
├── forms/
│   ├── PermissionsForm.tsx (461 lines)
│   ├── HardwareRequirementsForm.tsx
│   ├── ToolsEditor.tsx
│   ├── SettingsEditor.tsx (1100+ lines) ← LEGACY, hide for new apps
│   └── ImageUpload.tsx
├── dialogs/
│   ├── ApiKeyDialog.tsx
│   ├── SharingDialog.tsx
│   ├── PublishDialog.tsx
│   └── ...
├── AppTable.tsx → MiniAppTable.tsx
└── ui/ (54+ shadcn components)
```

### Current Theming
Already has CSS variables in `index.css` with `@custom-variant dark` defined but not implemented. Architecture is future-proofed for dark mode.

---

## Implementation Phases

### Phase 1: Terminology Changes

**1.1 File Renames**

| Current | New |
|---------|-----|
| `CreateApp.tsx` | `CreateMiniApp.tsx` |
| `EditApp.tsx` | `EditMiniApp.tsx` |
| `AppList.tsx` | `MiniAppList.tsx` |
| `AppTable.tsx` | `MiniAppTable.tsx` |

Update router config in `App.tsx` accordingly.

**1.2 User-Facing String Changes**

Search and replace in these files:
- `CreateApp.tsx` / `EditApp.tsx`
- `AppTable.tsx`
- `SharingDialog.tsx`
- `PublishDialog.tsx`
- `CreateOrgDialog.tsx`
- `OrganizationSettings.tsx`
- `ContactEmailBanner.tsx`

| Find | Replace |
|------|---------|
| `"Create New App"` | `"Create New MiniApp"` |
| `"Edit App"` | `"Edit MiniApp"` |
| `"My Apps"` | `"My MiniApps"` |
| `"app store"` | `"Mentra MiniApp Store"` |
| `"App Store"` | `"Mentra MiniApp Store"` |
| `"MentraOS app store"` | `"Mentra MiniApp Store"` |
| `"MentraOS App Store"` | `"Mentra MiniApp Store"` |
| `"Logo URL"` | `"MiniApp Logo"` |
| `"Hardware Requirements"` | `"Minimum Hardware Requirements"` |
| `"AI Tools"` (section header) | `"Mentra AI Tools"` |

**1.3 Keep Unchanged**
- Internal type names (`AppI`, `AppType`, `App`) - from SDK
- API paths (`/apps/...`) - backend contract
- Variable names in code

---

### Phase 2: Dead Code & Legacy Features

**2.1 Remove Onboarding Instructions**

Files to modify:
- `CreateMiniApp.tsx`: Remove the entire "Onboarding Instructions Section" (lines ~456-475)
- `EditMiniApp.tsx`: Remove the entire "Onboarding Instructions Section" (lines ~1186-1203)
- Remove from `formData` initial state in both files
- Remove from form submission payload
- Keep in TypeScript types for backward compat with existing data

**2.2 Hide Legacy Settings System**

In `CreateMiniApp.tsx`:
- Remove SettingsEditor entirely (it's not currently shown anyway - confirmed)

In `EditMiniApp.tsx`:
- Hide SettingsEditor for apps that don't already have settings:
```tsx
{(formData.settings?.length ?? 0) > 0 && (
  <div className="mt-6 border rounded-md p-4">
    <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
      ⚠️ App Settings is deprecated. You can remove existing settings but cannot add new ones.
    </div>
    <SettingsEditor
      settings={formData.settings || []}
      onChange={handleSettingsChange}
      allowAddNew={false}  // New prop to disable "Add Setting" button
      {...otherProps}
    />
  </div>
)}
```

Modify `SettingsEditor.tsx`:
- Add `allowAddNew?: boolean` prop (default: true for backward compat)
- Hide "Add Setting" button when `allowAddNew={false}`

---

### Phase 3: Logical Grouping

Create new section components and reorganize the form:

**3.1 New Component: `FormSection.tsx`**

```tsx
interface FormSectionProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  helpLink?: { text: string; href: string };
  children: React.ReactNode;
  defaultOpen?: boolean;
}
```

**3.2 Proposed Layout Structure**

```
┌─────────────────────────────────────────────────────────┐
│ 📦 MiniApp Distribution                                 │
├─────────────────────────────────────────────────────────┤
│ Package Name*        [com.example.myapp            ]    │
│ Display Name*        [My Awesome MiniApp           ]    │
│ Description*         [What your MiniApp does...    ]    │
│ MiniApp Logo*        [Upload component             ]    │
│ Preview Images       [Multi-upload] (EditMiniApp only)  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ ⚙️ MiniApp Configuration                     [Learn more]│
├─────────────────────────────────────────────────────────┤
│ Server URL*          [yourserver.com        ] [Verify]  │
│   └─ "How to get this" link                             │
│   └─ Ngrok explanation text                             │
│                                                         │
│ ☐ Use custom Webview URL                                │
│   └─ When OFF: "https://yourserver.com/webview" (grey)  │
│   └─ When ON:  [editable input field        ]           │
│   └─ "What is this?" link                               │
│                                                         │
│ App Type             [Background ▼]                     │
│                                                         │
│ ▸ Permissions                              [Learn more] │
│ ▸ Minimum Hardware Requirements            [Learn more] │
│ ▸ Mentra AI Tools                          [Learn more] │
│ ▸ [Legacy] App Settings (if has settings)               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ 🔧 MiniApp Development (EditMiniApp only)               │
├─────────────────────────────────────────────────────────┤
│ API Key              [••••••••••••] [View] [Regenerate] │
│ Configuration        [Import] [Export]                  │
│ Share with Testers   [Generate Link]                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ 🚀 Publish to Mentra MiniApp Store (EditMiniApp only)   │
├─────────────────────────────────────────────────────────┤
│ Status: [DEVELOPMENT / SUBMITTED / PUBLISHED / REJECTED]│
│ [Store Guidelines]                                      │
│ [Publish to Store] / [Resubmit]                         │
└─────────────────────────────────────────────────────────┘
```

---

### Phase 4: New Features

**4.1 Server URL Verification**

New component: `ServerUrlInput.tsx`

```tsx
interface ServerUrlInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error?: string;
}

// Features:
// - Input field for URL
// - "Verify" button that calls backend
// - Auto-verify after 3s of no typing
// - Status indicator: ✓ Reachable / ✗ Unreachable / ⏳ Checking
```

Backend endpoint needed:
```
POST /api/apps/verify-url
Body: { url: string }
Response: { reachable: boolean, error?: string }
```

The backend should:
1. Normalize URL (add https if missing)
2. Try to hit `${url}/health` with a 5s timeout
3. Return success if HTTP 2xx, failure otherwise

**4.2 Webview URL Toggle**

New component: `WebviewUrlToggle.tsx`

```tsx
interface WebviewUrlToggleProps {
  serverUrl: string;
  customWebviewUrl: string;
  useCustomUrl: boolean;
  onUseCustomUrlChange: (value: boolean) => void;
  onCustomUrlChange: (value: string) => void;
}

// When toggle is OFF:
// - Display computed URL in grey: "${serverUrl}/webview"
// - This value gets sent to backend as webviewURL

// When toggle is ON:
// - Show editable input for custom URL
// - This value gets sent to backend as webviewURL
```

**4.3 Help Link Component**

New component: `HelpLink.tsx`

```tsx
interface HelpLinkProps {
  href: string;
  children: React.ReactNode;
}

// Renders:
// <a href={href} target="_blank" className="text-blue-600 hover:underline text-sm">
//   {children} <ExternalLink className="inline h-3 w-3" />
// </a>
```

**4.4 Enhanced Permission Descriptions**

Update `PermissionsForm.tsx` to show descriptions more prominently:

Current `PERMISSION_DISPLAY_INFO` already has descriptions, but they're only shown when editing. Make them visible in collapsed view too.

**4.5 Store Guidelines Page**

New page: `StoreGuidelines.tsx` (or add to existing page)

Route: `/store-guidelines`

Content (placeholder):
```markdown
# Mentra MiniApp Store Guidelines

To be accepted into the Mentra MiniApp Store, your MiniApp must meet the following requirements:

## Technical Requirements
- Server must be reachable and respond to health checks
- Minimum hardware requirements must be accurate
- All required permissions must be justified

## Content Requirements
- Description must accurately reflect functionality
- Logo must be appropriate (512x512 PNG recommended)
- No misleading claims or descriptions

## Prohibited Content
- No third-party payment gateways inside webviews
- No content that violates applicable laws
- No malware or harmful code

## Review Process
1. Submit your MiniApp for review
2. Our team will test functionality and compliance
3. You'll receive approval or feedback within X business days

[Questions? Contact us on Discord]
```

---

### Phase 5: Styling Improvements

**5.1 Image Upload Redesign**

Current `ImageUpload.tsx` needs visual polish:
- Add drag-and-drop zone with dashed border
- Show upload progress
- Better preview with remove button
- Consistent sizing

**5.2 Preview Images Upload Redesign**

Similar improvements for multi-image upload component.

**5.3 Section Cards**

Use consistent card styling for form sections:
- Clear headers with icons
- Subtle background differentiation
- Collapsible where appropriate

**5.4 Typography**

Already using Cuprum font. Ensure consistent heading hierarchy:
- Section titles: `text-lg font-semibold`
- Field labels: `text-sm font-medium`
- Help text: `text-xs text-gray-500`

---

### Phase 6: Code Consolidation (Deferred)

**Not required for this iteration.** As long as we're using reusable components (FormSection, ServerUrlInput, WebviewUrlToggle, HelpLink, etc.), the duplication between Create/Edit is acceptable.

Future consideration: Merge into shared `MiniAppForm.tsx` if maintenance becomes painful.

---

## File Change Summary

### Phase 1: Terminology
| File | Change Type |
|------|-------------|
| `src/pages/CreateApp.tsx` | Rename + string updates |
| `src/pages/EditApp.tsx` | Rename + string updates |
| `src/pages/AppList.tsx` | Rename + string updates |
| `src/components/AppTable.tsx` | Rename + string updates |
| `src/components/dialogs/SharingDialog.tsx` | String updates |
| `src/components/dialogs/PublishDialog.tsx` | String updates |
| `src/components/dialogs/CreateOrgDialog.tsx` | String updates |
| `src/pages/OrganizationSettings.tsx` | String updates |
| `src/components/ui/ContactEmailBanner.tsx` | String updates |
| `src/App.tsx` | Route updates |

### Phase 2: Dead Code
| File | Change Type |
|------|-------------|
| `src/pages/CreateMiniApp.tsx` | Remove onboarding field |
| `src/pages/EditMiniApp.tsx` | Remove onboarding field, conditionally show settings |
| `src/components/forms/SettingsEditor.tsx` | Add `allowAddNew` prop |

### Phase 3: Logical Grouping
| File | Change Type |
|------|-------------|
| `src/components/forms/FormSection.tsx` | New component |
| `src/pages/CreateMiniApp.tsx` | Reorganize into sections |
| `src/pages/EditMiniApp.tsx` | Reorganize into sections |

### Phase 4: New Features
| File | Change Type |
|------|-------------|
| `src/components/forms/ServerUrlInput.tsx` | New component |
| `src/components/forms/WebviewUrlToggle.tsx` | New component |
| `src/components/common/HelpLink.tsx` | New component |
| `src/pages/StoreGuidelines.tsx` | New page |
| `src/services/api.service.ts` | Add verify-url endpoint |
| `src/components/forms/PermissionsForm.tsx` | Show descriptions prominently |
| `src/components/forms/HardwareRequirementsForm.tsx` | Add help link |
| `src/components/forms/ToolsEditor.tsx` | Add explanation + help link |

### Phase 5: Styling
| File | Change Type |
|------|-------------|
| `src/components/forms/ImageUpload.tsx` | Visual redesign |
| `src/index.css` | Any additional styles |

---

## Backend Requirements

1. **New endpoint: `POST /api/apps/verify-url`** (included in Phase 4)
   - Input: `{ url: string }`
   - Behavior: Normalize URL, hit `${url}/health` with 5s timeout, return reachability
   - Output: `{ reachable: boolean, error?: string }`
   - Location: `cloud/packages/cloud/src/api/hono/routes/apps.routes.ts`

**Note:** Webview URL defaulting handled in frontend (not backend). Settings restriction deferred.

---

## Implementation Order

1. **Phase 1: Terminology** (~2-3 hours)
   - Low risk, immediate visible impact

2. **Phase 2: Dead Code** (~1 hour)
   - Clean slate before adding features

3. **Phase 3: Logical Grouping** (~3-4 hours)
   - Create FormSection component
   - Reorganize both form pages

4. **Phase 4: New Features** (~5-6 hours)
   - ServerUrlInput with verification
   - WebviewUrlToggle (default to `${serverUrl}/webview` in frontend)
   - HelpLink component
   - Store Guidelines page
   - Update form components with links
   - **Backend:** Add `POST /api/apps/verify-url` endpoint

5. **Phase 5: Styling** (~2-3 hours)
   - Image upload components
   - General polish

**Total estimated: 13-17 hours** (includes backend endpoint)

---

## Not In Scope (Docs Changes)

The ticket mentions updating `docs.mentraglass.com` example apps section - this should be a separate docs PR:
- Add links to "Webview Example" section
- Add links to "Mira Tools" section

---

## Questions Resolved ✓

All clarification questions have been answered. Ready to proceed with implementation.
