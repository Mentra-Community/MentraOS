import { ChatOpenAI } from "@langchain/openai";
import { AzureChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatVertexAI } from "@langchain/google-vertexai";

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const AZURE_OPENAI_API_INSTANCE_NAME = process.env.AZURE_OPENAI_API_INSTANCE_NAME || "";
const AZURE_OPENAI_API_DEPLOYMENT_NAME = process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME || "";
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2023-05-15";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// LLM Configuration
// Need to define LLMModel enum for the switch case in LLMProvider
export enum LLMModel {
  GPT4 = 'gpt-4o',
  GPT4_MINI = 'gpt-4o-mini',
  CLAUDE = 'claude-3',
  GEMINI = 'gemini-pro',
}

export enum LLMService {
  AZURE = 'azure',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
}

export const LLM_MODEL = process.env.LLM_MODEL || LLMModel.GPT4;
export const LLM_PROVIDER = process.env.LLM_PROVIDER || LLMService.AZURE;

export class LLMProvider {
  static getLLM(options?: { temperature?: number; maxTokens?: number; [key: string]: any }) {
    const supportedAzureModels = [
      LLMModel.GPT4,
    ]
    const supportedOpenAIModels = [
      LLMModel.GPT4,
      LLMModel.GPT4_MINI,
    ]
    const supportedAnthropicModels = [
      LLMModel.CLAUDE,
    ]

    // Convert model to enum value if it's a string
    const model = typeof LLM_MODEL === 'string' ? LLM_MODEL as LLMModel : LLM_MODEL;
    const provider = LLM_PROVIDER || LLMService.AZURE;

    const defaultOptions = {
      temperature: 0.3,
      maxTokens: 300,
    };

    // Merge all options, including any extra keys (like responseFormat)
    const finalOptions = { ...defaultOptions, ...(options || {}) };

    if (provider === LLMService.AZURE) {
      if (!supportedAzureModels.includes(model as LLMModel)) {
        throw new Error(`Unsupported Azure model: ${model}`);
      }
      return new AzureChatOpenAI({
        modelName: model,
        azureOpenAIApiKey: AZURE_OPENAI_API_KEY,
        azureOpenAIApiVersion: AZURE_OPENAI_API_VERSION,
        azureOpenAIApiInstanceName: AZURE_OPENAI_API_INSTANCE_NAME,
        azureOpenAIApiDeploymentName: AZURE_OPENAI_API_DEPLOYMENT_NAME,
        ...finalOptions,
      });
    } else if (provider === LLMService.OPENAI) {
      if (!supportedOpenAIModels.includes(model as LLMModel)) {
        throw new Error(`Unsupported OpenAI model: ${model}`);
      }
      return new ChatOpenAI({
        modelName: model,
        openAIApiKey: OPENAI_API_KEY,
        ...finalOptions,
      });
    } else if (provider === LLMService.ANTHROPIC) {
      if (!supportedAnthropicModels.includes(model as LLMModel)) {
        throw new Error(`Unsupported Anthropic model: ${model}`);
      }
      return new ChatAnthropic({
        modelName: model,
        anthropicApiKey: ANTHROPIC_API_KEY,
        ...finalOptions,
      });
    } else {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}