# MentraOS Developer Portal Guidelines

## Build Commands

- **Build**: `npm run build` (TypeScript compile + Vite build)
- **Dev**: `npm run dev` (Starts development server with hot reload)
- **Lint**: `npm run lint` (ESLint checks)
- **Preview**: `npm run preview` (Preview production build)

## Code Style Guidelines

- **TypeScript**: Use strict typing with interfaces for all data structures
- **React**: Functional components with hooks (avoid class components)
- **Formatting**: 2-space indentation, double quotes for JSX
- **Imports**: Group external/internal, sort alphabetically
  - React imports first
  - External libraries next
  - Internal components/hooks/utilities last
- **Naming**:
  - PascalCase for components and type interfaces
  - camelCase for variables, functions, and instances
  - Use descriptive, semantic names
- **Error Handling**: Use try/catch blocks with appropriate error logging
- **Authentication**: Use the useAuth hook for authentication-related functionality
- **Styling**: Utilize Tailwind CSS with shadcn/ui components
- **State Management**: React Context for global state
- **API Calls**: Use the api.service.ts for all backend communication
- **Routing**: React Router v6 with protected routes

## Project Structure

- **/src/components**: Reusable UI components with shadcn organization
- **/src/pages**: Main application views
- **/src/hooks**: Custom React hooks
- **/src/context**: Context providers for global state
- **/src/types**: TypeScript interfaces and type definitions
- **/src/services**: API services and utilities
- **/src/utils**: Helper functions and utilities
