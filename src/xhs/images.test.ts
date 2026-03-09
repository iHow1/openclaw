import { describe, expect, it } from "vitest";
import { guessImageExtension } from "./images.ts";

describe("guessImageExtension", () => {
  it("prefers the URL pathname extension when it is image-like", () => {
    expect(guessImageExtension("https://cdn.example.com/path/photo.png?size=large")).toBe(".png");
  });

  it("falls back to the content type when the URL has no useful suffix", () => {
    expect(guessImageExtension("https://cdn.example.com/rendered", "image/webp")).toBe(".webp");
  });

  it("defaults to jpg when neither the URL nor content type is specific", () => {
    expect(guessImageExtension("https://cdn.example.com/rendered")).toBe(".jpg");
  });
});
