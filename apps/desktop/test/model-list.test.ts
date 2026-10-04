import { describe, expect, it } from "vitest";
import { chatModels, parseModelList } from "../src/shared/model-list";

describe("switchable model list", () => {
  it("accepts newlines, commas and spaces, drops duplicates and invalid names", () => {
    expect(parseModelList("gpt-5.5\ngpt-5.5-mini, gpt-5.5  bad name;\n\nqwen/qwen3:32b"))
      .toEqual(["gpt-5.5", "gpt-5.5-mini", "bad", "qwen/qwen3:32b"]);
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList(Array.from({ length: 80 }, (_, index) => `m${index}`))).toHaveLength(50);
  });

  it("keeps only chat models from a provider list, sorted", () => {
    expect(chatModels(["gpt-5.5", "text-embedding-3-small", "whisper-1", "gpt-4o-mini-tts", "dall-e-3", "gpt-5.5-mini", "o4-mini"]))
      .toEqual(["gpt-5.5", "gpt-5.5-mini", "o4-mini"]);
  });
});
