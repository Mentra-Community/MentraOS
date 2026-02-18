# MentraOS Web Store Development Guide

## Commands

- Build: `bun run build` (runs TypeScript build + Vite build)
- Dev server: `bun run dev`
- Lint: `bun run lint`
- Preview build: `bun run preview`

## Code Style Guidelines

- **TypeScript**: Use strict typing, prefer interfaces over types for objects
- **Imports**: Group imports by external/internal, sort alphabetically
- **Components**: Use functional components with React hooks
- **Naming**: PascalCase for components, camelCase for functions/variables
- **Error Handling**: Use try/catch with appropriate error logging
- **Formatting**: Use 2-space indentation, semicolons, single quotes
- **State Management**: Prefer React hooks over class components
- **CSS**: Use component-scoped CSS or Tailwind utility classes
- **Documentation**: Include JSDoc comments for complex functions
- **Testing**: Test components with React Testing Library

This project uses Vite, React, TypeScript and follows modern React best practices.
