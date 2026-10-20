/** Normalize probe failures into stable PROVIDER_* messages for the config API. */
export const modelProfileTestFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim() || "Model provider probe failed.";
  if (trimmed.startsWith("PROVIDER_CONFIG_MISSING:") || trimmed.startsWith("PROVIDER_TEST_FAILED:")) {
    return trimmed;
  }
  if (looksLikeUnreachableProvider(error, trimmed)) {
    return "PROVIDER_TEST_FAILED:Connection timed out while reaching the model provider.";
  }
  return `PROVIDER_TEST_FAILED:${trimmed}`;
};

/**
 * Normalize a failed generation into the same PROVIDER_* messages.
 *
 * Kept apart from the probe above only so the wording stays probe-specific; the
 * classification is shared, because an unreachable model host says the same
 * thing whether the deployment was testing the profile or asking it to work.
 * Without it a repair against a host that is simply down returns a generic
 * internal failure, which the operator can only read as "the model answered
 * badly" — a different problem with a different fix.
 */
export const modelGenerationFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim() || "Model generation failed.";
  if (trimmed.startsWith("PROVIDER_CONFIG_MISSING:") || trimmed.startsWith("PROVIDER_TEST_FAILED:")) {
    return trimmed;
  }
  if (looksLikeUnreachableProvider(error, trimmed)) {
    return "PROVIDER_TEST_FAILED:Connection timed out while reaching the model provider.";
  }
  const provider = error as { statusCode?: unknown; responseBody?: unknown } | null;
  const status = provider && typeof provider.statusCode === "number" ? provider.statusCode : null;
  if (status !== null) {
    return `PROVIDER_TEST_FAILED:The model provider answered with status ${status}.`;
  }
  return `PROVIDER_TEST_FAILED:${trimmed}`;
};

/**
 * Whether a failure reads as "the host never answered" rather than "the host
 * answered badly".
 *
 * A refused or unresolvable connection arrives as a bare `fetch failed` with the
 * real reason on `cause`, so both levels of the chain are searched; naming the
 * cause is the whole point, because it is the part that says which host and which
 * port were tried.
 */
const looksLikeUnreachableProvider = (error: unknown, message: string): boolean => {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true;
  }
  let text = message;
  if (error instanceof Error && error.cause !== undefined) {
    text = `${text} ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
  }
  return /timed?\s*out|aborted|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up/iu.test(text);
};


/** Short success confirmation for connectivity test responses. */
export const modelProfileTestSuccessReason = (input: {
  model: string;
  response: string;
}): string => {
  const response = input.response.trim();
  if (response) {
    return `Model "${input.model}" responded successfully (${response}).`;
  }
  return `Model "${input.model}" responded successfully.`;
};

export const isRevisionConflictError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("REVISION_CONFLICT:");
};
