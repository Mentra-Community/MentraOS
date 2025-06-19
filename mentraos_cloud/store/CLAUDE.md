# AugmentOS Cloud Store Development Guide

## Build Commands
- **Web**: `cd web && bun run build` (TypeScript + Vite build)
- **Web Dev**: `cd web && bun run dev` (Vite dev server)
- **Server**: `cd server && bun run build` (TypeScript compilation)
- **Server Dev**: `cd server && bun run dev` (Watch mode with tsx)
- **Server Deploy**: `cd server && bun run deploy` (Build + start)

## Lint Commands
- **Web**: `cd web && bun run lint` (ESLint)

## Code Style Guidelines
- **TypeScript**: Use strict typing, prefer interfaces over objects
- **Imports**: Group by external/internal, sort alphabetically
- **Components**: Use functional React components with hooks
- **Naming**: PascalCase for components, camelCase for functions/variables
- **Error Handling**: Use try/catch with appropriate error logging
- **Formatting**: 2-space indentation, semicolons, single quotes
- **CSS**: Use component-scoped CSS or Tailwind utility classes
- **Documentation**: JSDoc comments for complex functions

## Project Structure
- **/web**: React/Vite frontend using TypeScript and Tailwind
- **/server**: TypeScript backend for the AugmentOS Store

This project uses Bun as the package manager throughout the codebase.