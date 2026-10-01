import { expect, test } from "@playwright/test";
import {
  stringifyToolValue,
  toolOutputImages,
} from "../../src/features/conversation/tool-output-images";

const output = {
  content: [
    { type: "text", text: "two images" },
    { type: "image", data: "UE5HREFUQQ==", mimeType: "image/png" },
    { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" },
  ],
};

test("only listed image types become thumbnails", () => {
  expect(toolOutputImages(output)).toEqual([{ data: "UE5HREFUQQ==", mimeType: "image/png" }]);
  expect(toolOutputImages({ content: "text" })).toEqual([]);
  expect(toolOutputImages(undefined)).toEqual([]);
});

test("the row's text hides every image's data, shown or not", () => {
  const text = stringifyToolValue(output);
  expect(text).toContain("[image/png image]");
  expect(text).toContain("[image/svg+xml image]");
  expect(text).not.toContain("UE5HREFUQQ==");
  expect(text).not.toContain("PHN2Zz4=");
  expect(text).toContain("two images");
});
