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
export enum LLMModel {
  // OpenAI / Azure models
  GPT5_2 = 'gpt-5.2',
  GPT4_1 = 'gpt-4.1',
  GPT4_1_MINI = 'gpt-4.1-mini',
  GPT4O = 'gpt-4o',
  GPT4O_MINI = 'gpt-4o-mini',
  O3 = 'o3',
  O3_MINI = 'o3-mini',
  O4_MINI = 'o4-mini',
  // Anthropic models
  CLAUDE_SONNET = 'claude-sonnet-4-20250514',
  CLAUDE_OPUS = 'claude-opus-4-20250514',
  CLAUDE_HAIKU = 'claude-3-5-haiku-20241022',
  // Google models
  GEMINI_3 = 'gemini-3.0-pro',
  GEMINI_25_PRO = 'gemini-2.5-pro',
  GEMINI_25_FLASH = 'gemini-2.5-flash',
}

export enum LLMService {
  AZURE = 'azure',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
}

export const LLM_MODEL = process.env.LLM_MODEL || LLMModel.GPT5_2;
export const LLM_PROVIDER = process.env.LLM_PROVIDER || LLMService.OPENAI;

export class LLMProvider {
  static getLLM(options?: { temperature?: number; maxTokens?: number; [key: string]: any }) {
    const supportedAzureModels = [
      LLMModel.GPT5_2,
      LLMModel.GPT4_1,
      LLMModel.GPT4_1_MINI,
      LLMModel.GPT4O,
      LLMModel.GPT4O_MINI,
      LLMModel.O3,
      LLMModel.O3_MINI,
      LLMModel.O4_MINI,
    ]
    const supportedOpenAIModels = [
      LLMModel.GPT5_2,
      LLMModel.GPT4_1,
      LLMModel.GPT4_1_MINI,
      LLMModel.GPT4O,
      LLMModel.GPT4O_MINI,
      LLMModel.O3,
      LLMModel.O3_MINI,
      LLMModel.O4_MINI,
    ]
    const supportedAnthropicModels = [
      LLMModel.CLAUDE_SONNET,
      LLMModel.CLAUDE_OPUS,
      LLMModel.CLAUDE_HAIKU,
    ]
    const supportedGoogleModels = [
      LLMModel.GEMINI_3,
      LLMModel.GEMINI_25_PRO,
      LLMModel.GEMINI_25_FLASH,
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
    } else if (provider === LLMService.GOOGLE) {
      if (!supportedGoogleModels.includes(model as LLMModel)) {
        throw new Error(`Unsupported Google model: ${model}`);
      }
      return new ChatVertexAI({
        model: model,
        ...finalOptions,
      });
    } else {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}