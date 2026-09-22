import fs from "node:fs";

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function extractFirstJsonValue(text) {
  const source = String(text || "");
  for (let start = 0; start < source.length; start += 1) {
    const first = source[start];
    if (first !== "{" && first !== "[") continue;
    const stack = [first === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack[stack.length - 1] !== char) break;
        stack.pop();
        if (stack.length === 0) {
          const candidate = source.slice(start, index + 1);
          const parsed = safeJsonParse(candidate, null);
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function parseAiJsonContent(content) {
  const direct = safeJsonParse(content, null);
  if (direct) return direct;
  const stripped = String(content || "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return safeJsonParse(stripped, null) || extractFirstJsonValue(stripped);
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return safeJsonParse(fs.readFileSync(filePath, "utf-8"), fallback);
}

export { parseAiJsonContent, readJsonIfExists, safeJsonParse };
