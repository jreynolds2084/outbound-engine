import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  model?: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

// ── LLM provider: OpenRouter ─────────────────────────────────────────────────
// The payload this file builds is plain OpenAI chat-completions, which is what
// OpenRouter accepts, so switching providers is a URL, a key, and the
// model-slug map below.
//
// LLM_API_URL overrides the endpoint if the provider changes.

const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const resolveApiUrl = () =>
  ENV.llmApiUrl && ENV.llmApiUrl.trim().length > 0
    ? ENV.llmApiUrl.trim()
    : DEFAULT_API_URL;

const assertApiKey = () => {
  if (!ENV.llmApiKey) {
    throw new Error(
      "No LLM API key configured — set OPENROUTER_API_KEY (or LLM_API_KEY)."
    );
  }
};

/**
 * The model every call uses unless it passes `model:` explicitly.
 *
 * Single source of truth, per code-review C2 ("centralize model choice in one
 * config constant instead of a hardcoded default plus per-call overrides").
 */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Internal model ID → OpenRouter slug.
 *
 * Every target below was verified present in OpenRouter's live model list on
 * 2026-07-28. Callers pass short IDs, so a vendor change needs no call-site
 * edits.
 *
 * An ID containing "/" is assumed to already be a provider slug and passes
 * through untouched, so newer models can be tried without a code change.
 */
export const MODEL_SLUGS: Record<string, string> = {
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6", // $3.00/M in, $15.00/M out
  "gpt-5": "openai/gpt-5", //                            $1.25/M in, $10.00/M out
  "gemini-2.5-flash": "google/gemini-2.5-flash", //      $0.30/M in,  $2.50/M out
};

export const resolveModelSlug = (model: string): string => {
  if (model.includes("/")) return model;
  return MODEL_SLUGS[model] ?? model;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();

  const {
    model: modelOverride,
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  // C2 fix (2026-07): default is claude-sonnet-4-6, not the bake-off-rejected
  // gemini-2.5-flash. Callers needing a specific model still pass model: "..."
  const requestedModel = modelOverride ?? DEFAULT_MODEL;

  const payload: Record<string, unknown> = {
    model: resolveModelSlug(requestedModel),
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  // Respect caller-supplied max_tokens; fall back to model-appropriate default.
  // Test against the REQUESTED id, not payload.model, that is now an
  // OpenRouter slug ("google/gemini-2.5-flash"), so the old startsWith("gemini")
  // check would silently stop matching and halve the token budget.
  const callerMaxTokens = params.max_tokens ?? params.maxTokens;
  const isGemini = /(^|\/)gemini/.test(requestedModel);
  payload.max_tokens = callerMaxTokens ?? (isGemini ? 32768 : 8192);

  // thinking/budget_tokens is a Gemini-only feature, never send to Claude or GPT
  if (isGemini) {
    payload.thinking = {
      "budget_tokens": 128
    };
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetch(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.llmApiKey}`,
      // OpenRouter attribution headers, optional, and how usage is grouped in
      // its dashboard. Handy for splitting spend per tenant later.
      "HTTP-Referer": process.env.PUBLIC_SITE_URL ?? "https://example.com",
      "X-Title": "Outbound Beast",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as InvokeResult;
}
