import { GoogleGenerativeAI } from "@google/generative-ai";
import { getConfig } from "../config";

// Gemini is only used for the conversational /api/query endpoint now.
// All event classification has moved to services/rules.ts (rule-based, no LLM).

let _client: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI {
  if (!_client) {
    const config = getConfig();
    _client = new GoogleGenerativeAI(config.GEMINI_API_KEY);
  }
  return _client;
}

// --- Query Processing ---

export async function processQuery(
  query: string,
  pipelineData: string
): Promise<string> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: `Here is the current pipeline data:\n\n${pipelineData}\n\nUser question: ${query}` }],
      },
    ],
    systemInstruction: {
      role: "model",
      parts: [{
        text: `You are a conversational sales pipeline assistant for a B2B outbound agency founder.
Answer questions about their pipeline, deals, and activity in a natural, conversational tone.
Don't dump raw data — interpret it and give actionable insights.
Be concise but thorough. Use specific numbers, names, and dates when available.
If you don't have enough data to answer, say so clearly.`,
      }],
    },
    generationConfig: {
      maxOutputTokens: 2048,
    },
  });

  return result.response.text();
}
