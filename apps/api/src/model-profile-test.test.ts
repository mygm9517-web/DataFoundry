import { describe, expect, it } from "vitest";

import { modelGenerationFailureMessage, modelProfileTestFailureMessage } from "./model-profile-test.js";

/**
 * Why this exists: an unreachable model host and a model that answered badly
 * both surface as a thrown error, and the console renders them with different
 * fixes. The deployment's own `.env` points at a host that is not answering, so
 * the first classification is the one an operator actually meets — and a
 * regression here reads as "the model replied with nothing usable", which sends
 * them to edit a page that was never the problem.
 */
describe("model failure classification", () => {
  it("names an unreachable host from a bare fetch failure", () => {
    // This is the shape the failure actually arrives in: the OpenAI client
    // reports `fetch failed`, and the host and port are on `cause`.
    const error = new Error("fetch failed");
    error.cause = new Error("connect ECONNREFUSED");

    expect(modelGenerationFailureMessage(error))
      .toBe("PROVIDER_TEST_FAILED:Connection timed out while reaching the model provider.");
  });

  it("names an unreachable host the probe way too", () => {
    const error = new Error("fetch failed");
    error.cause = new Error("getaddrinfo ENOTFOUND model.internal");

    expect(modelProfileTestFailureMessage(error))
      .toBe("PROVIDER_TEST_FAILED:Connection timed out while reaching the model provider.");
  });

  it("reports the status when the host answered and rejected the request", () => {
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401 });

    expect(modelGenerationFailureMessage(error))
      .toBe("PROVIDER_TEST_FAILED:The model provider answered with status 401.");
  });

  it("keeps a message that is already classified", () => {
    // These prefixes are what the route keys off; re-wrapping one would lose the
    // distinction the console is reading.
    expect(modelGenerationFailureMessage(new Error("PROVIDER_CONFIG_MISSING:server-default")))
      .toBe("PROVIDER_CONFIG_MISSING:server-default");
    expect(modelGenerationFailureMessage(new Error("PROVIDER_TEST_FAILED:already said")))
      .toBe("PROVIDER_TEST_FAILED:already said");
  });

  it("passes an unclassifiable failure through rather than flattening it", () => {
    expect(modelGenerationFailureMessage(new Error("the model returned prose, not a page")))
      .toBe("PROVIDER_TEST_FAILED:the model returned prose, not a page");
  });

  it("treats a timeout-shaped failure as a reachability problem", () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";

    expect(modelGenerationFailureMessage(error))
      .toBe("PROVIDER_TEST_FAILED:Connection timed out while reaching the model provider.");
  });
});
