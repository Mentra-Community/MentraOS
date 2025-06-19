// SearchTool.ts

import { Tool } from '@langchain/core/tools';
import { SerpAPI } from '@langchain/community/tools/serpapi';

export const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";

interface SearchInput {
  searchKeyword: string;
  includeImage?: boolean;
}

/**
 * SearchTool is a LangChain Tool class that searches for additional information
 * about an entity using SerpAPI.
 *
 * To call this tool, pass a JSON string with the following format:
 * {
 *   "searchKeyword": "your search query",
 *   "includeImage": false  // optional, defaults to false
 * }
 *
 * The tool returns a JSON string with the search result details.
 */
export class SearchToolForAgents extends Tool {
  name = 'Search Engine';
  description = 'Searches the web for information about a given query. Pass this tool specific queries and/or keywords to quickly search the WWW to retrieve information on any topic like academic research, history, entertainment, current events. This tool does NOT work for personal information and does NOT work for math.';
  private serpApi: SerpAPI;

  constructor() {
    super();
    this.serpApi = new SerpAPI(SERPAPI_API_KEY || '');
  }

  /**
   * The main method to run the tool.
   * @param input A JSON string representing an object with searchKeyword and optionally includeImage.
   * @returns A JSON string with keys: url, snippet, and optionally imageUrl.
   */
  async _call(input: string): Promise<string> {
    let params: SearchInput;
    try {
      // Parse the input JSON string.
      params = JSON.parse(input);
    } catch (e) {
      // If parsing fails, treat the entire input as the search query.
      params = { searchKeyword: input, includeImage: false };
    }
  
    const { searchKeyword, includeImage = false } = params;
  
    try {
      // Invoke the SerpAPI call with the search query.
      const searchUrl = `https://serpapi.com/search?q=${encodeURIComponent(searchKeyword)}&engine=google&api_key=${SERPAPI_API_KEY}&hl=en&gl=us`;
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await fetch(searchUrl);
      const result = await response.json();
      
      // Log the raw results if needed.
      // console.log("$$$$$ SearchToolForAgents Result:", JSON.stringify(result));

      // Format the results using the helper function.
      const formattedOutput = this.formatSearchResults(result);
      // console.log("Formatted Search Results:\n", formattedOutput);
      
      // Return the formatted result as a JSON string.
      return JSON.stringify({ result: formattedOutput });
    } catch (error) {
      console.error(`Error during search for "${searchKeyword}":`, error);
      return JSON.stringify({
        url: `https://www.google.com/search?q=${encodeURIComponent(searchKeyword)}`,
        snippet: `Error occurred while searching for ${searchKeyword}.`,
      });
    }
  }

  private formatSearchResults(result: any): string {
    const formattedLines: string[] = [];
  
    // Format organic results
    const organicResults = result.organic_results || [];
    organicResults.forEach((entry: any) => {
      const title = entry.title?.trim() || "No Title";
      const source = entry.source?.trim() || "No Source";
      const snippet = entry.snippet?.trim() || "No Snippet";
      formattedLines.push(`Title: ${title}\nSource: ${source}\nSnippet: ${snippet}`);
    });
  
    // Format knowledge graph if available
    if (result.knowledge_graph) {
      const kg = result.knowledge_graph;
      const kgTitle = kg.title || "No Title";
      const kgType = kg.type;
      // If an entity type exists, add it as a line.
      if (kgType) {
        formattedLines.push(`${kgTitle}: ${kgType}.`);
      }
      // Add the knowledge graph description.
      const kgDescription = kg.description;
      if (kgDescription) {
        formattedLines.push(kgDescription);
      }
      // Process any attributes in the knowledge graph.
      if (kg.attributes) {
        for (const attribute in kg.attributes) {
          if (kg.attributes.hasOwnProperty(attribute)) {
            const value = kg.attributes[attribute];
            formattedLines.push(`${kgTitle} ${attribute}: ${value}.`);
          }
        }
      }
    }

    // console.log("Formatted Lines:", formattedLines);
  
    // Join all entries with an extra newline between them
    return formattedLines.join("\n");
  }
}
