/**
 * Calculator Tool using expr-eval
 *
 * Provides safe mathematical calculation capability.
 * Uses expr-eval which is lightweight and doesn't use eval().
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Parser } from "expr-eval";

// Create a parser instance
const parser = new Parser();

export const calculatorTool = createTool({
  id: "calculator",
  description: "Perform mathematical calculations. Use for arithmetic, conversions, percentages, tip calculations, etc.",
  inputSchema: z.object({
    expression: z.string().describe("Mathematical expression to evaluate (e.g., '15 * 0.2', '100 / 4', 'sqrt(16)')"),
  }),
  outputSchema: z.object({
    result: z.number().describe("Calculation result"),
    error: z.string().optional().describe("Error message if calculation failed"),
  }),
  execute: async (input) => {
    const { expression } = input;

    console.log(`🧮 Calculating: "${expression}"`);

    try {
      // expr-eval is safe (no eval()), supports:
      // - Basic arithmetic: +, -, *, /, %, ^
      // - Parentheses: ()
      // - Functions: sqrt, abs, ceil, floor, round, sin, cos, tan, log, exp, etc.
      // - Constants: PI, E
      const result = parser.evaluate(expression);

      if (typeof result !== 'number' || !Number.isFinite(result)) {
        console.warn(`⚠️ Invalid calculation result: ${result}`);
        return { result: NaN, error: "Invalid calculation result" };
      }

      console.log(`✅ Result: ${result}`);
      return { result };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error(`❌ Calculation error: ${errorMessage}`);
      return { result: NaN, error: errorMessage };
    }
  },
});
