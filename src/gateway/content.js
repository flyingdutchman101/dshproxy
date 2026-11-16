// What a request carries. DeepSeek Harness attaches text and images only, so
// an image part is the one thing that decides which lane rungs can serve a
// request: a text-only model rejects an image, and failing over to one would
// only fail again.

const IMAGE_TYPES = new Set(["image", "input_image", "image_url"]);

function carriesImage(body) {
  if (!body || typeof body !== "object") return false;
  const hasImage = (content) => Array.isArray(content) && content.some((part) => part && typeof part === "object" && IMAGE_TYPES.has(part.type));
  if (hasImage(body.content)) return true; // Anthropic: content blocks at the top
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) if (hasImage(message?.content)) return true;
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) if (hasImage(item?.content)) return true;
  }
  return false;
}

// The rungs to try for this request: all of them, or only the image-capable
// ones when an image is attached.
function filterForImages(ladder, body, supportsImages) {
  if (!carriesImage(body)) return ladder;
  return ladder.filter((model) => supportsImages(model));
}

module.exports = { carriesImage, filterForImages };
