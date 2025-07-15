// MiraAgent.ts

import { Agent } from "./AgentInterface";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { SearchToolForAgents } from "./tools/SearchToolForAgents";
import { PromptTemplate } from "@langchain/core/prompts";
import { LLMProvider } from "@mentra/utils";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { McpConfig } from "./utils/mcpConfig";

interface QuestionAnswer {
    insight: string;
}

const agentPromptBlueprint = `You are an intelligent assistant that is running on the smart glasses of a user. They sometimes directly talk to you by saying a wake word and then asking a question (User Query). Answer the User Query to the best of your ability. Try to infer the User Query intent even if they don't give enough info. The query may contain some extra unrelated speech not related to the query - ignore any noise to answer just the user's intended query. Make your answer concise, leave out filler words, make the answer high entropy, answer in 15 words or less (no newlines), but don't be overly brief (e.g. for weather, give temp. and rain). Use telegraph style writing.

Utilize available tools when necessary and adhere to the following guidelines:
1. Invoke the "Search Engine" tool for confirming facts or retrieving extra details. Use the Search Engine tool to search the web for information about the user's query whenever you don't have enough information to answer.
2. Keep your final answer brief (fewer than 15 words).
3. When calling a tool, use this precise format:
   Action: Search Engine
   Action Input: {{"searchKeyword": "<query>", "includeImage": <true/false>}}
4. When you have enough information to answer, output your final answer on a new line prefixed by "Final Answer:" followed immediately by a JSON object exactly like:
   {{"insight": "<concise answer>"}}
5. If the query is empty, return Final Answer: {{"insight": "No query provided."}}
6. Do not output any other text.
7. For context, today's date is ${new Date().toUTCString().split(' ').slice(0,4).join(' ')}.

User Query:
{query}

Tools:
{tools}
Tool Names:
{tool_names}
Agent Scratchpad:
{agent_scratchpad}

Remember to always include the Final Answer: marker in your response.`;

export class MiraAgent implements Agent {
  public agentId = "mira_agent";
  public agentName = "MiraAgent";
  public agentDescription =
    "Answers user queries from smart glasses using conversation context and history.";
  public agentPrompt = agentPromptBlueprint;
  public agentTools = [new SearchToolForAgents()];

  /**
   * Transform our McpConfig format to MultiServerMCPClient format
   */
  private transformMcpConfig(mcpConfig: McpConfig): any {
    const mcpServers: any = {};
    
    for (const [serverName, serverConfig] of Object.entries(mcpConfig)) {
      if (serverConfig.transport === 'stdio') {
        mcpServers[serverName] = {
          transport: 'stdio',
          command: serverConfig.command,
          args: serverConfig.args || [],
          restart: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000
          }
        };
      } else if (serverConfig.transport === 'streamable_http') {
        mcpServers[serverName] = {
          transport: 'streamable_http',
          url: serverConfig.url,
          headers: serverConfig.headers || {},
          automaticSSEFallback: true
        };
      }
    }
    
    return mcpServers;
  }

  /**
   * Get user's MCP configuration from database
   * @param userEmail The user's email address
   * @returns Promise<McpConfig> The user's MCP configuration
   */

  /**
   * Parses the final LLM output.
   * If the output contains a "Final Answer:" marker, the text after that marker is parsed as JSON.
   * Expects a JSON object with an "insight" key.
   */
  private parseOutput(text: string): QuestionAnswer {

    console.log("MiraAgent Text:", text);
    const finalMarker = "Final Answer:";
    if (text.includes(finalMarker)) {
      text = text.split(finalMarker)[1].trim();
    }
    try {
      const parsed = JSON.parse(text);
      // If the object has an "insight" key, return it.
      if (typeof parsed.insight === "string") {
        return { insight: parsed.insight };
      }
      // If the output is a tool call (e.g. has searchKeyword) or missing insight, return a null insight.
      if (parsed.searchKeyword) {
        return { insight: "null" };
      }
    } catch (e) {
      // Fallback attempt to extract an "insight" value from a string
      const match = text.match(/"insight"\s*:\s*"([^"]+)"/);
      if (match) {
        return { insight: match[1] };
      }
    }
    return { insight: "Error processing query." };
  }

  public async handleContext(userContext: Record<string, any>): Promise<any> {
    try {
      // Extract required fields from the userContext.
      const transcriptHistory = userContext.transcript_history || "";
      const insightHistory = userContext.insight_history || "";
      const query = userContext.query || "";

      // If query is empty, return default response.
      if (!query.trim()) {
        return { result: "No query provided." };
      }

      console.log("Query:", query);

      const llm = LLMProvider.getLLM();
      const prompt = new PromptTemplate({
        template: this.agentPrompt,
        inputVariables: ["transcript_history", "insight_history", "query", "input", "tools", "tool_names", "agent_scratchpad"],
      });

      // Load MCP tools if config exists
      let allTools: any[] = [...this.agentTools];
      let mcpConfig = userContext.mcpConfig;
      
      
      
      if (mcpConfig && Object.keys(mcpConfig).length > 0) {
        try {
          // Transform our McpConfig format to MultiServerMCPClient format
          const mcpClientConfig = {
            mcpServers: this.transformMcpConfig(mcpConfig)
          };
          
          const mcpClient = new MultiServerMCPClient(mcpClientConfig);
          const mcpTools = await mcpClient.getTools();
          allTools = [...allTools, ...mcpTools];
          console.log(`MiraAgent: Loaded ${mcpTools.length} MCP tools from ${Object.keys(mcpConfig).length} servers`);
        } catch (error) {
          console.warn('MiraAgent: MCP tools failed to load:', error);
        }
      }

      // console.log("Prompt:", prompt.template);

      const agent = await createReactAgent({
        llm,
        tools: allTools,
        prompt,
      });

      const executor = new AgentExecutor({
        agent,
        tools: allTools,
        maxIterations: 5,
        verbose: process.env.NODE_ENV === "development",
      });

      const toolNames = allTools.map((tool) => tool.name || "unknown");
      const agentScratchpad = "";

      const result = await executor.invoke({
        // transcript_history: transcriptHistory,
        // insight_history: insightHistory,
        query,
        tools: allTools,
        tool_names: toolNames,
        agent_scratchpad: agentScratchpad,
      });

      console.log("Result:", result.output);
      const parsedResult = this.parseOutput(result.output);
      return parsedResult.insight;
    } catch (err) {
      console.error("[MiraAgent] Error:", err);
      const errString = String(err);
      return errString.match(/LLM output:\s*(.*)$/)?.[1] || "Error processing query.";
    }
  }
}
