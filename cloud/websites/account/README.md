# MentraOS Account Portal

This is the account management portal for MentraOS users. It provides users with the ability to:

- View their profile information
- Delete their account
- Export their data

## Features

- **Profile Management**: View and update your profile information.
- **Account Deletion**: Request deletion of your account and all associated data.
- **Data Export**: Request and download an export of all your MentraOS data.

## Development

### Prerequisites

- Node.js v20+
- npm v10+

### Setup

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file with the following variables:

```
VITE_SUPABASE_URL=https://global.mentra.glass
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

4. Start the development server:

```bash
npm run dev
```

The app will be available at `http://localhost:8052`.

### Building for Production

```bash
npm run build
```

This will create a production-ready build in the `dist` directory.

## Architecture

This application is built with:

- **React**: UI library
- **React Router**: For routing
- **Supabase**: For authentication
- **Tailwind CSS**: For styling
- **Axios**: For API requests

Authentication is integrated with the existing MentraOS authentication system, using Supabase Auth.

## API Endpoints

The application communicates with the following API endpoints:

- `/api/account/me`: Get user profile information
- `/api/account/profile`: Update user profile
- `/api/account/request-deletion`: Request account deletion
- `/api/account/confirm-deletion`: Confirm account deletion
- `/api/account/request-export`: Request data export
- `/api/account/export-status`: Check export status
- `/api/account/download-export/:id`: Download exported data

Note: Update cloudflare to use bun for installing and building the application.
