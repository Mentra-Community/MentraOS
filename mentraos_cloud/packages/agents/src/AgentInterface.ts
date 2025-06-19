export interface Agent {
  agentId: string;
  agentName: string;
  agentDescription: string;
  agentPrompt: string;
  agentTools: any[];

  handleContext(inputData: any): Promise<{
    [key: string]: any;
  }>;
}
