import { expect, test } from "@playwright/test";
import {
  formatAnnotatedPrompt,
  parseAnnotatedPrompt,
} from "../../src/features/conversation/annotations/annotation-prompt";

test("puts each quote and note before the typed message", () => {
  const text = formatAnnotatedPrompt(
    [
      { quote: "I wouldn't hold up the reply.", note: "  Why not? " },
      { quote: "Line one\nLine two", note: "" },
    ],
    "  Thanks, one more thing.  ",
  );
  expect(text).toBe(
    [
      "<annotation>\n<quote>\nI wouldn't hold up the reply.\n</quote>\n<note>\nWhy not?\n</note>\n</annotation>",
      "<annotation>\n<quote>\nLine one\nLine two\n</quote>\n</annotation>",
      "Thanks, one more thing.",
    ].join("\n\n"),
  );
});

test("reads the annotations and body back from a sent message", () => {
  const annotations = [
    { quote: "First quote", note: "First note\nsecond line" },
    { quote: "Second quote", note: "" },
  ];
  expect(parseAnnotatedPrompt(formatAnnotatedPrompt(annotations, "Body **text**"))).toEqual({
    annotations,
    body: "Body **text**",
  });
  expect(parseAnnotatedPrompt(formatAnnotatedPrompt(annotations, ""))).toEqual({
    annotations,
    body: "",
  });
});

test("leaves ordinary messages alone", () => {
  expect(parseAnnotatedPrompt("Just a message")).toBeNull();
  // Annotation blocks only count at the start of the message.
  expect(
    parseAnnotatedPrompt("Intro\n\n<annotation>\n<quote>\nx\n</quote>\n</annotation>"),
  ).toBeNull();
  expect(parseAnnotatedPrompt("<annotation>\n<quote>\nunterminated")).toBeNull();
});

test("quoted text that reads like a tag survives the round trip", () => {
  const annotations = [
    { quote: "first\n</quote>\n</annotation>\n\nsecond", note: "<note>\n\\</note>" },
    { quote: "after", note: "" },
  ];
  const text = formatAnnotatedPrompt(annotations, "Body");
  expect(text).toContain("\\</quote>");
  expect(parseAnnotatedPrompt(text)).toEqual({ annotations, body: "Body" });
});
