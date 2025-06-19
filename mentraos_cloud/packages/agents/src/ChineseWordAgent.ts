import { Agent } from "./AgentInterface";
import { PromptTemplate } from "@langchain/core/prompts";
import { LLMProvider } from "@augmentos/utils";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { CommaSeparatedListOutputParser } from "langchain/output_parsers";

interface AgentOutput {
  insight: string;
}

const MAX_HISTORY_SIZE = 50; // Keep track of last 50 items

const agentPromptBlueprint = `You are a Chinese language expert specializing in intermediate to advanced vocabulary. Your goal is to teach users new, practical Chinese words that will expand their vocabulary and deepen their understanding of the language.

When generating words, follow these rules:
1. Select words that are:
   - Intermediate to advanced level (HSK 4-6)
   - Commonly used in modern Chinese
   - Practical and useful in everyday situations
2. Format each word entry as:
   "汉字 (pinyin) - English translation"
3. Keep entries concise and clear
4. Do not repeat any previously shared content
5. IMPORTANT: For each response, output ONE random word from any of these parts of speech:
   - Nouns (名词): 专业 (zhuān yè) - Profession
   - Verbs (动词): 发展 (fā zhǎn) - To develop
   - Adjectives (形容词): 重要 (zhòng yào) - Important
   - Adverbs (副词): 逐渐 (zhú jiàn) - Gradually
6. Focus on words that are:
   - Professional terminology
   - Academic vocabulary
   - Business terms
   - Technical vocabulary
   - Common nouns and verbs
   - Descriptive adjectives
   - Important adverbs

Example format:
- 专业 (zhuān yè) - Profession
- 发展 (fā zhǎn) - To develop
- 重要 (zhòng yào) - Important
- 逐渐 (zhú jiàn) - Gradually

Question: Generate a new Chinese word entry. Choose ONE random word from any part of speech (noun, verb, adjective, or adverb).

When you have a word to share, output your final answer on a new line prefixed by "Final Answer:" followed immediately by a JSON object exactly like:
Final Answer: {{"insight": "<single word entry>"}}

{agent_scratchpad}`;

export class ChineseWordAgent implements Agent {
  public agentId = 'chinese_words';
  public agentName = 'Chinese Vocabulary Teacher';
  public agentDescription = 'Provides intermediate to advanced level Chinese vocabulary with pinyin and translations. Best for users looking to expand their Chinese language skills beyond basic conversation.';
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
        "idioms", "business", "culture", "academic", "modern usage",
        "philosophy", "literature", "technology", "social", "professional"
      ];
      const randomCategory = randomCategories[Math.floor(Math.random() * randomCategories.length)];

      // Weighted random selection for parts of speech
      const partsOfSpeech = [
        { type: "nouns", weight: 0.3 },
        { type: "verbs", weight: 0.3 },
        { type: "adjectives", weight: 0.3 },
        { type: "adverbs", weight: 0.1 }
      ];

      const random = Math.random();
      let selectedPartOfSpeech = partsOfSpeech[0].type;
      let cumulativeWeight = 0;

      for (const part of partsOfSpeech) {
        cumulativeWeight += part.weight;
        if (random <= cumulativeWeight) {
          selectedPartOfSpeech = part.type;
          break;
        }
      }

      // Get shared history from userContext
      const agentHistory = userContext.agentHistory || [];
      
      // Add history to the prompt to avoid repetition
      const historyContext = agentHistory.length > 0 
        ? `\nPreviously shared content (do not repeat any of these):\n${agentHistory.join('\n')}`
        : '';
      
      const prompt = new PromptTemplate({
        template: this.agentPrompt + `\nConsider focusing on ${randomCategory} for variety and generate a ${selectedPartOfSpeech} word.${historyContext}`,
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

      console.log('[ChineseWordAgent] Result:', result.output);

      const parsedResult = this.parseOutput(result.output);
      
      // Return both the word and updated history
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
      console.error('[ChineseWordAgent] Error:', err);
      return {
        insight: "null",
        agentHistory: userContext.agentHistory || []
      };
    }
  }
} 