import { Agent } from "./AgentInterface";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputFunctionsParser } from "langchain/output_parsers";
import { LLMProvider } from "@mentra/utils";

/**
 * Interface for the aggregated response from the AgentGatekeeper.
 */
interface GatekeeperResponse {
  message: string;
  selectedAgents: string[];
  output: any[];
}

const agentGatekeeperPrompt = `# Objective
You are an agent router. I will provide:
1. The user's context.
2. A list of agents (with ID, name, and description).

You must decide which agents are best suited to handle the user's request.
Output a JSON array of the agent IDs that should be invoked, in order of relevance.
If no agent is relevant, return an empty array.

Do not provide any additional text or formatting, just valid JSON.

User Context:
{user_context}

Agents:
{agent_list}

Return ONLY the IDs in a JSON array, e.g. ["agent1", "agent2"] or []`;

/**
 * The AgentGatekeeper is responsible for:
 * 1) Selecting the appropriate agent(s) using an LLM prompt.
 * 2) Invoking the selected agent(s).
 * 3) Aggregating and returning their results.
 */
export class AgentGatekeeper {
  private agents: Agent[];
  private agentPrompt: string;

  /**
   * Creates an instance of AgentGatekeeper.
   * @param agents - Array of agents implementing the Agent interface.
   */
  constructor(agents: Agent[]) {
    this.agents = agents;
    this.agentPrompt = agentGatekeeperPrompt;
  }

  /**
   * Processes the provided context by:
   * 1. Querying the LLM to select relevant agents.
   * 2. Invoking those agents with the context.
   * 3. Returning aggregated results.
   *
   * @param inputData - User data, typically including a conversation context.
   * @returns An aggregated response from all selected agents.
   */
  public async processContext(inputData: Record<string, any>): Promise<GatekeeperResponse> {
    // 1) Gather user context as text (or JSON string if needed)
    const userContext = inputData.conversation_context || JSON.stringify(inputData);

    // 2) Prepare agent metadata for the LLM prompt
    const agentsData = this.agents.map((agent) => ({
      id: agent.agentId,
      name: agent.agentName,
      description: agent.agentDescription,
    }));

    // 3) Query the LLM (via LangChain) to determine which agents to invoke
    const selectedAgentIds = await this.llmSelectAgents(userContext, agentsData);

    if (selectedAgentIds.length === 0) {
      console.log(`[AgentGatekeeper] No agents selected by LLM.`);
      return {
        message: "No relevant agents selected by LLM.",
        selectedAgents: [],
        output: [],
      };
    }

    // 4) Filter for relevant agents from the list
    const relevantAgents = this.agents.filter((agent) =>
      selectedAgentIds.includes(agent.agentId)
    );

    if (relevantAgents.length === 0) {
      console.log(`[AgentGatekeeper] LLM returned agent IDs not found in agent list.`);
      return {
        message: "LLM returned agent IDs not found in agent list.",
        selectedAgents: selectedAgentIds,
        output: [],
      };
    }

    // 5) Invoke each selected agent concurrently and aggregate their results
    const results = await Promise.all(
      relevantAgents.map(async (agent) => {
        try {
          const result = await agent.handleContext(inputData);
          return { agentId: agent.agentId, ...result };
        } catch (error: any) {
          console.error(`[AgentGatekeeper] Error in agent ${agent.agentId}:`, error);
          return { agentId: agent.agentId, error: error.message };
        }
      })
    );

    // 6) Return the aggregated results
    return {
      message: "Success",
      selectedAgents: selectedAgentIds,
      output: results,
    };
  }

  /**
   * Uses LangChain’s LLM to determine which agent IDs should be invoked.
   *
   * @param userContext - Text describing the user's context.
   * @param agentsData - Array of agent metadata with id, name, and description.
   * @returns An array of agent IDs selected by the LLM.
   */
  private async llmSelectAgents(
    userContext: string,
    agentsData: { id: string; name: string; description: string }[]
  ): Promise<string[]> {
    // Format the list of agents in the style similar to the NewsAgent prompt.
    const agentListString = agentsData
      .map(
        (a) =>
          `- { "id": "${a.id}", "name": "${a.name}", "description": "${a.description}" }`
      )
      .join("\n");

    // Define the prompt template for agent selection.
    const prompt = new PromptTemplate({
      template: this.agentPrompt,
      inputVariables: ["user_context", "agent_list"],
    });

    // Format the prompt with the user context and agent list.
    const formattedPrompt = await prompt.format({
      user_context: userContext,
      agent_list: agentListString,
    });

    // Initialize the LLM using LangChain’s LLMProvider.
    const llm = LLMProvider.getLLM();

    try {
      // Invoke the LLM.
      const response = await llm.invoke(formattedPrompt);
      const responseText = response.content.toString();

      // Use LangChain's JSON output parser to force valid JSON output.
      const outputParser = new JsonOutputFunctionsParser({ argsOnly: true });
      const parsed = (await outputParser.parse(responseText)) as { [key: string]: any };

      // Expecting the parsed output to be a JSON array.
      if (Array.isArray(parsed)) {
        return parsed;
      } else {
        // If the output is not directly an array, check for a key.
        return parsed.agent_ids || [];
      }
    } catch (error: any) {
      console.error("[AgentGatekeeper] Error from LLM during agent selection:", error);
      return [];
    }
  }
}
