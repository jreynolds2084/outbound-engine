export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // LLM provider: OpenRouter by default. LLM_API_URL only needs setting if the
  // provider changes; the default endpoint is in _core/llm.ts.
  llmApiKey: process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "",
  llmApiUrl: process.env.LLM_API_URL ?? "",
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID ?? "",
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
};
