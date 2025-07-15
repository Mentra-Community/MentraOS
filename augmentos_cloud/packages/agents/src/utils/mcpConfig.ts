// MCP Server Configuration Types
export interface McpServerConfig {
  transport: 'stdio' | 'streamable_http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  [serverName: string]: McpServerConfig;
}

/**
 * Validate MCP server configuration
 * @param serverConfig The server configuration to validate
 * @returns True if valid, false otherwise
 */
export function validateMcpServerConfig(serverConfig: McpServerConfig): boolean {
  if (!serverConfig.transport) {
    return false;
  }

  if (serverConfig.transport === 'stdio') {
    // For stdio transport, command is required
    return !!serverConfig.command;
  } else if (serverConfig.transport === 'streamable_http') {
    // For HTTP transport, url is required
    return !!serverConfig.url;
  }

  return false;
}

/**
 * Validate entire MCP configuration
 * @param config The MCP configuration to validate
 * @returns Array of validation errors, empty if valid
 */
export function validateMcpConfig(config: McpConfig): string[] {
  const errors: string[] = [];

  if (typeof config !== 'object' || config === null) {
    errors.push('Config must be an object');
    return errors;
  }

  for (const [serverName, serverConfig] of Object.entries(config)) {
    if (!serverName || typeof serverName !== 'string') {
      errors.push('Server names must be non-empty strings');
      continue;
    }

    if (!validateMcpServerConfig(serverConfig)) {
      errors.push(`Invalid configuration for server '${serverName}'`);
    }
  }

  return errors;
}