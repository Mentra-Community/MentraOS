import { Agent } from "./AgentInterface";
import { PromptTemplate } from "@langchain/core/prompts";
import { LLMProvider } from "@augmentos/utils";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { CommaSeparatedListOutputParser } from "langchain/output_parsers";

interface AgentOutput {
  insight: string;
}

const MAX_HISTORY_SIZE = 50; // Keep track of last 50 items

const agentPromptBlueprint = `You are an AI assistant specialized in generating gratitude prompts and reflections. Your goal is to help users cultivate gratitude and appreciation for the positive aspects of their life.

When generating gratitude prompts, follow these rules:
1. Focus on prompts that encourage reflection on meaningful aspects of life
2. Keep prompts concise (under 15 words)
3. Make prompts personal and relatable
4. Avoid clichés and overly generic statements
5. Do not repeat any previously shared content (including other agent outputs)
6. Format: Start with "Be grateful for:" followed by the prompt
7. Make prompts specific and actionable

Question: Generate a gratitude prompt.

When you have a gratitude prompt to share, output your final answer on a new line prefixed by "Final Answer:" followed immediately by a JSON object exactly like:
Final Answer: {{"insight": "<gratitude prompt>"}}

{agent_scratchpad}

{tools}

{tool_names}`;

export class GratitudePingAgent implements Agent {
  public agentId = 'gratitude_ping';
  public agentName = 'Gratitude Prompt Generator';
  public agentDescription = 'Generates thoughtful gratitude prompts to help users reflect on and appreciate the positive aspects of their life. Best for promoting mindfulness and positive thinking.';
  public agentExamples = '';
  public agentPrompt = agentPromptBlueprint;
  public agentTools = [];

  public parseOutput(text: string): AgentOutput {
    const finalMarker = "Final Answer:";
    if (text.includes(finalMarker)) {
      text = text.split(finalMarker)[1].trim();
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.insight === "string") {
        return { insight: parsed.insight };
      }
    } catch (e) {
      const match = text.match(/"insight"\s*:\s*"([^"]+)"/);
      if (match) {
        return { insight: match[1] };
      }
    }
    return { insight: "null" };
  }

  public async handleContext(userContext: Record<string, any>): Promise<any> {
    try {
      const llm = LLMProvider.getLLM({
        temperature: 0.9,
      });

      const randomCategories = [
        "personal growth", "relationships", "health", "opportunities", "achievements",
        "daily comforts", "nature", "technology", "community", "learning"
      ];
      const randomCategory = randomCategories[Math.floor(Math.random() * randomCategories.length)];
      
      // Get shared history from userContext
      const agentHistory = userContext.agentHistory || [];
      
      // Add history to the prompt to avoid repetition
      const historyContext = agentHistory.length > 0 
        ? `\nPreviously shared content (do not repeat any of these):\n${agentHistory.join('\n')}`
        : '';
      
      const prompt = new PromptTemplate({
        template: this.agentPrompt + `\nConsider focusing on ${randomCategory} for variety.${historyContext}`,
        inputVariables: ["agent_scratchpad", "tools", "tool_names"],
      });

      const agent = await createReactAgent({
        llm,
        tools: this.agentTools,
        prompt,
      });

      const executor = new AgentExecutor({
        agent,
        tools: this.agentTools,
        maxIterations: 1,
        verbose: false,
      });

      const result = await executor.invoke({});

      console.log('[GratitudePingAgent] Result:', result.output);

      const parsedResult = this.parseOutput(result.output);
      
      // Return both the prompt and updated history
      if (parsedResult.insight && parsedResult.insight !== "null") {
        const updatedHistory = [...agentHistory, parsedResult.insight];
        // Keep history size manageable
        if (updatedHistory.length > MAX_HISTORY_SIZE) {
          updatedHistory.shift(); // Remove oldest item
        }
        return {
          insight: parsedResult.insight,
          agentHistory: updatedHistory
        };
      }
      
      return {
        insight: "null",
        agentHistory: agentHistory
      };
    } catch (err) {
      console.error('[GratitudePingAgent] Error:', err);
      return {
        insight: "null",
        agentHistory: userContext.agentHistory || []
      };
    }
  }
} 