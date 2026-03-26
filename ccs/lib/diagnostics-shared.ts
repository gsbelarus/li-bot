export interface OpenAiDiagnosticsError {
  message: string;
  status: number | null;
  code: string | null;
  type: string | null;
  param: string | null;
  requestId: string | null;
}

export interface OpenAiDiagnosticsResponse {
  ok: boolean;
  model: string;
  project: string | null;
  checks: {
    apiKeyConfigured: boolean;
    modelSpecified: boolean;
    openAiReachable: boolean;
    apiKeyAccepted: boolean | null;
    accountFunded: boolean | null;
  };
  response?: {
    completionId: string | null;
    messagePreview: string;
  };
  error?: OpenAiDiagnosticsError;
}