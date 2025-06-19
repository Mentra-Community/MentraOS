import { Agent } from "./AgentInterface";
import { PromptTemplate } from "@langchain/core/prompts";
import { LLMProvider } from "@augmentos/utils";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { CommaSeparatedListOutputParser } from "langchain/output_parsers";

interface AgentOutput {
  insight: string;
}

const MAX_HISTORY_SIZE = 50; // Keep track of last 50 items

const agentPromptBlueprint = `You are an AI assistant specialized in providing inspiring and thought-provoking quotes from famous figures throughout history. Your goal is to share meaningful, impactful, and memorable quotes that resonate with the audience.

When generating quotes, follow these rules:
1. Focus on quotes that are inspiring, thought-provoking, or particularly meaningful
2. Keep quotes concise (under 20 words)
3. Ensure quotes are accurately attributed to real historical figures
4. Avoid controversial or inappropriate content
5. Do not repeat any previously shared content (including both fun facts and quotes)
6. ALWAYS include the author's name in the quote format: "Quote" - Author
7. Make sure the attribution is clear and prominent in the output

Question: Generate an inspiring quote from a famous figure.

When you have a quote to share, output your final answer on a new line prefixed by "Final Answer:" followed immediately by a JSON object exactly like:
Final Answer: {{"insight": "<quote>"}}

{agent_scratchpad}

{tools}

{tool_names}`;

export class FamousQuotesAgent implements Agent {
  public agentId = 'famous_quotes';
  public agentName = 'Famous Quotes Generator';
  public agentDescription = 'Generates inspiring and thought-provoking quotes from famous figures throughout history. Call this agent when you want to share meaningful, impactful, or memorable quotes. Best for adding motivational content to conversations or presentations.';
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
      // If the object has an "insight" key, return it.
      if (typeof parsed.insight === "string") {
        return { insight: parsed.insight };
      }
    } catch (e) {
      // Fallback attempt to extract an "insight" value from a string
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
        "leadership", "wisdom", "success", "creativity", "courage",
        "innovation", "philosophy", "science", "art", "humanity"
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

      console.log('[FamousQuotesAgent] Result:', result.output);

      const parsedResult = this.parseOutput(result.output);
      
      // Return both the quote and updated history
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
      console.error('[FamousQuotesAgent] Error:', err);
      return {
        insight: "null",
        agentHistory: userContext.agentHistory || []
      };
    }
  }
} 