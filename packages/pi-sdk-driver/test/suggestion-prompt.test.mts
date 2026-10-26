import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSuggestionExcerpt,
  sanitizeSuggestedPrompt,
  SUGGESTION_SYSTEM_PROMPT,
} from "../dist/suggestion-prompt.js";

await test("suggester system prompt asks for a bare prompt only", () => {
  assert.match(SUGGESTION_SYSTEM_PROMPT, /ONLY/i);
});

await test("excerpt keeps recent messages with role labels and caps length", () => {
  const messages = [
    { role: "user" as const, text: "fix the login bug" },
    { role: "assistant" as const, text: "Fixed it in auth.ts." },
    { role: "user" as const, text: "   " },
  ];
  const excerpt = buildSuggestionExcerpt(messages);
  assert.ok(excerpt.includes("User: fix the login bug"));
  assert.ok(excerpt.includes("Assistant: Fixed it in auth.ts."));
});

await test("excerpt caps total length", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: "user" as const,
    text: `message number ${index} with enough padding to grow the excerpt ${"x".repeat(200)}`,
  }));
  const excerpt = buildSuggestionExcerpt(messages);
  assert.ok(excerpt.length <= 3000);
  assert.ok(excerpt.includes("message number 19"));
});

await test("sanitize strips quotes, bullets and whitespace", () => {
  assert.equal(sanitizeSuggestedPrompt('"Run the tests."'), "Run the tests.");
  assert.equal(sanitizeSuggestedPrompt("- Check for regressions"), "Check for regressions");
  assert.equal(
    sanitizeSuggestedPrompt("  Explain the diff\nin detail  "),
    "Explain the diff in detail",
  );
});

await test("sanitize rejects empty or non-string replies", () => {
  assert.equal(sanitizeSuggestedPrompt(""), undefined);
  assert.equal(sanitizeSuggestedPrompt("   "), undefined);
  assert.equal(sanitizeSuggestedPrompt(undefined), undefined);
  assert.equal(sanitizeSuggestedPrompt(42), undefined);
  assert.equal(sanitizeSuggestedPrompt('""'), undefined);
});

await test("sanitize caps long replies", () => {
  const long = `Review ${"everything ".repeat(50)}`;
  const result = sanitizeSuggestedPrompt(long);
  assert.ok(result);
  assert.ok(result.length <= 220);
});
