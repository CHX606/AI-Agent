import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, normalizeImages, type ImageAttachment } from "../src/shared/image-input.js";

const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");
function png(bytes = 24): ImageAttachment {
  const data = Buffer.alloc(bytes); pngHeader.copy(data);
  return { name: "截图.png", mime_type: "image/png", data_url: `data:image/png;base64,${data.toString("base64")}` };
}

describe("image attachment validation", () => {
  it("preserves plain messages and copies normalized image input", () => {
    expect(normalizeImages(undefined)).toEqual([]);
    const source = png();
    const images = normalizeImages([{ ...source, name: " 截图.png " }]);
    expect(images).toEqual([source]);
    expect(images[0]).not.toBe(source);
  });

  it.each([
    ["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ffe0"],
    ["image/webp", "524946460000000057454250"], ["image/gif", "474946383961"],
  ])("allows %s with matching data and signature", (mime_type, signature) => {
    const data_url = `data:${mime_type};base64,${Buffer.from(signature, "hex").toString("base64")}`;
    expect(normalizeImages([{ name: "image", mime_type, data_url }])).toHaveLength(1);
  });

  it.each([
    ["null", null], ["non-array", {}], ["non-object", [null]], ["bad name type", [{ ...png(), name: 1 }]],
    ["empty name", [{ ...png(), name: " " }]], ["long name", [{ ...png(), name: "x".repeat(256) }]],
    ["path", [{ ...png(), name: "../image.png" }]], ["windows path", [{ ...png(), name: "C:\\image.png" }]],
    ["drive-relative name", [{ ...png(), name: "C:image.png" }]], ["C1 control name", [{ ...png(), name: "image\u0085.png" }]],
    ["control character", [{ ...png(), name: "image\n.png" }]], ["SVG", [{ ...png(), mime_type: "image/svg+xml" }]],
    ["remote URL", [{ ...png(), data_url: "https://example.com/image.png" }]],
    ["MIME mismatch", [{ ...png(), data_url: "data:image/jpeg;base64,/9j/4A==" }]],
    ["signature mismatch", [{ ...png(), data_url: "data:image/png;base64,/9j/4A==" }]],
    ["invalid base64", [{ ...png(), data_url: "data:image/png;base64,%%%%" }]],
    ["non-canonical base64", [{ ...png(), data_url: "data:image/png;base64,iVBORw0KGgp=" }]],
    ["extra field", [{ ...png(), path: "C:/secret" }]],
  ])("rejects %s", (_label, input) => {
    expect(() => normalizeImages(input)).toThrow();
  });

  it("enforces count, single decoded size and total decoded size at their boundaries", () => {
    expect(normalizeImages(Array.from({ length: IMAGE_LIMITS.maxCount }, () => png()))).toHaveLength(5);
    expect(() => normalizeImages(Array.from({ length: 6 }, () => png()))).toThrow("最多");
    const maximum = png(IMAGE_LIMITS.maxImageBytes);
    expect(normalizeImages([maximum])).toHaveLength(1);
    expect(() => normalizeImages([png(IMAGE_LIMITS.maxImageBytes + 1)])).toThrow("5 MiB");
    expect(normalizeImages(Array.from({ length: 4 }, () => maximum))).toHaveLength(4);
    expect(() => normalizeImages([...Array.from({ length: 4 }, () => maximum), png()])).toThrow("20 MiB");
  });
});
