# MCP Integration for MiraAgent

## Overview

Added Model Context Protocol (MCP) support to MiraAgent, enabling users to configure external MCP servers through the developer console and have MiraAgent automatically use tools from those servers.

## What Changed

### 1. Added MCP Support to MiraAgent
- **File**: `packages/agents/src/MiraAgent.ts`
- **Changes**:
  - Added `langchain-mcp-adapters` dependency for MCP integration
  - Modified `handleContext()` to accept optional `mcpConfig` parameter
  - Added dynamic tool loading: when MCP config exists, creates `MultiServerMCPClient` and merges MCP tools with existing tools
  - Added graceful fallback: uses existing tools if no MCP config provided
  - Added user-specific MCP config loading from database

### 2. Database Storage for MCP Configuration
- **File**: `packages/cloud/src/models/user.model.ts`
- **Changes**:
  - Added `mcpConfig` field to User model schema with proper MongoDB Map structure
  - Added `updateMcpConfig(config: McpConfig)` method to save user's MCP configuration
  - Added `getMcpConfig(): McpConfig` method to retrieve user's MCP configuration
  - Proper JSON serialization handling for frontend compatibility

### 3. API Endpoints for MCP Management
- **File**: `packages/cloud/src/routes/developer.routes.ts`
- **Changes**:
  - Added `GET /api/developer/agents/mcp-config` - Read user's MCP configuration
  - Added `POST /api/developer/agents/mcp-config` - Update user's MCP configuration
  - Full validation and error handling with proper logging
  - Authentication required using existing token validation
  - User-specific configuration storage and retrieval

### 4. Frontend MCP Configuration UI
- **File**: `developer-portal/src/components/forms/ToolsEditor.tsx`
- **Changes**:
  - Added simple MCP configuration section below existing AI Tools
  - JSON editor for direct mcp.json configuration editing
  - Real-time JSON validation with error display
  - Example configuration in placeholder text
  - Clean, minimal interface for power users

### 5. TypeScript Types and Utilities
- **Files**: 
  - `packages/agents/src/utils/mcpConfig.ts` - MCP configuration types and validation
  - `developer-portal/src/types/mcp.ts` - Frontend MCP types  
- **Changes**:
  - Added MCP server configuration interfaces
  - Added validation functions for MCP configurations
  - Simple, clean type definitions focused on database storage
  - Proper TypeScript typing throughout

## Usage

Developers can now:
1. Edit MCP configuration directly as JSON in the developer console
2. Configure stdio-based servers (local processes) or HTTP-based servers  
3. Set authentication headers and other server options in JSON format
4. MiraAgent automatically loads and uses tools from configured MCP servers
5. All existing MiraAgent functionality remains unchanged