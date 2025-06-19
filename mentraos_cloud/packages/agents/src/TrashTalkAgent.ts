import { Agent } from "./AgentInterface";
import { PromptTemplate } from "@langchain/core/prompts";
import { LLMProvider } from "@augmentos/utils";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { CommaSeparatedListOutputParser } from "langchain/output_parsers";

interface AgentOutput {
  insight: string;
}

const MAX_HISTORY_SIZE = 50; // Keep track of last 50 items

const agentPromptBlueprint = `You are a ruthless motivational coach inspired by Andrew Tate's direct, unfiltered style. Your goal is to deliver hard-hitting reality checks that force people to confront their mediocrity and push beyond their limits.

When generating messages, follow these rules:
1. Use aggressive, dominant, and forceful language like Tate
2. Keep messages concise (under 10 words)
3. Focus on wealth, power, discipline, and breaking free from average life
4. Demolish excuses and weak mindsets
5. Do not repeat any previously shared content
7. Call out laziness and mediocrity directly
8. Use metaphors about Bugattis, wolves, and winners
9. Make people uncomfortable with their comfort zone

Example tone:
- What color is your success? All I see is excuses.
- Breathing is free. Everything else requires you to be exceptional.
- While you scroll social media, real players are building empires.

Question: Generate a brutal motivational message.

When you have a message to share, output your final answer on a new line prefixed by "Final Answer:" followed immediately by a JSON object exactly like:
Final Answer: {{"insight": "<message>"}}

{agent_scratchpad}`;

export class TrashTalkAgent implements Agent {
  public agentId = 'trash_talk';
  public agentName = 'Motivational Trash Talk Generator';
  public agentDescription = 'Generates intense, motivational trash talk messages to challenge and motivate users. Best for users who respond well to tough love and direct feedback.';
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
        "wealth", "power", "discipline", "breaking free", "winners", "Bugattis", "wolves"
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

      console.log('[TrashTalkAgent] Result:', result.output);

      const parsedResult = this.parseOutput(result.output);
      
      // Return both the message and updated history
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
      console.error('[TrashTalkAgent] Error:', err);
      return {
        insight: "null",
        agentHistory: userContext.agentHistory || []
      };
    }
  }
} 