// MCP (Model Context Protocol) Type Definitions

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