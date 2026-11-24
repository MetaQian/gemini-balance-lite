// 本地验证：mock fetch 拦截发给 Google 的请求体，检查 tool schema 清洗结果
const captured = {};
globalThis.fetch = async (url, opts) => {
  captured.url = url;
  captured.body = JSON.parse(opts.body);
  // 回一个最小可用的 generateContent 响应
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const proxy = (await import("./src/openai.mjs")).default;

const req = new Request("http://worker.local/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer fake-key" },
  body: JSON.stringify({
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      // MCP / Claude Code 风格：strict + $schema + additionalProperties + 嵌套
      {
        type: "function",
        function: {
          name: "mcp_tool",
          description: "MCP style tool",
          strict: true,
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              filters: {
                type: "array",
                title: "Filters",
                description: "filter list",
                items: {
                  type: "object",
                  properties: {
                    opts: { type: "object", additionalProperties: { type: "string" } },
                    tags: { type: "array", items: { type: "string", pattern: "^[a-z]+$" } },
                  },
                  additionalProperties: false,
                  required: ["opts"],
                },
              },
              mode: {
                description: "mode",
                oneOf: [
                  { type: "string", enum: ["a", "b"] },
                  { type: "object", additionalProperties: true },
                ],
              },
              count: { type: "number", default: 1, minimum: 0, maximum: 10, examples: [1, 2] },
              nested_any: { anyOf: [{ type: "string" }, { type: "number" }] },
              nested_all: { allOf: [{ type: "object" }, { type: "object", properties: { x: { type: "string" } } }], title: "T" },
            },
            required: ["filters"],
            additionalProperties: false,
          },
        },
      },
      // 普通 OpenAI 风格工具
      {
        type: "function",
        function: {
          name: "plain_tool",
          parameters: {
            type: "object",
            properties: { q: { type: "string", description: "query" } },
            required: ["q"],
          },
        },
      },
    ],
  }),
});

await proxy.fetch(req);
const body = captured.body;
const decls = body.tools[0].function_declarations;

// 递归断言：不允许出现任何白名单之外的键
const FORBIDDEN = new Set([
  "$schema", "additionalProperties", "anyOf", "allOf", "not", "const", "strict",
  "definitions", "$defs", "$id", "$comment", "$ref", "propertyNames", "patternProperties",
  "if", "then", "else", "minProperties", "maxProperties", "title", "default",
  "examples", "minimum", "maximum", "pattern", "minLength", "maxLength", "nullable",
]);
const ALLOWED = new Set(["type", "properties", "required", "items", "enum", "description", "format", "propertyOrdering", "oneOf"]);
// 声明级合法键（不是 schema 关键字）
const DECL_KEYS = new Set(["name", "description", "parameters"]);
let bad = [];
const walkSchema = (node, path) => {
  if (Array.isArray(node)) return node.forEach((v, i) => walkSchema(v, `${path}[${i}]`));
  if (typeof node !== "object" || node === null) return;
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN.has(k)) bad.push(`${path}.${k}`);
    if (!ALLOWED.has(k)) bad.push(`${path}.${k} (not in allowlist)`);
    if (k === "properties" && v && typeof v === "object") {
      // 键名是业务字段名，不校验；只递归值
      for (const [name, sub] of Object.entries(v)) walkSchema(sub, `${path}.${name}`);
    } else if (k !== "properties") {
      walkSchema(v, `${path}.${k}`);
    }
  }
};
decls.forEach((d, i) => {
  for (const [k, v] of Object.entries(d)) {
    if (!DECL_KEYS.has(k)) bad.push(`decl[${i}].${k} (not a declaration key)`);
    if (k === "parameters") walkSchema(v, `decl[${i}].parameters`);
  }
});

// 断言 1：无残留非法字段
if (bad.length) {
  console.error("FAIL 残留非法字段:\n  " + bad.join("\n  "));
  process.exit(1);
}
// 断言 2：oneOf 保留且分支被清洗
const mcp = decls[0];
if (mcp.parameters.properties.mode.oneOf?.length !== 2) {
  console.error("FAIL mode.oneOf 分支数应为 2, 实际:", JSON.stringify(mcp.parameters.properties.mode));
  process.exit(1);
}
if (mcp.parameters.properties.mode.oneOf[0].enum?.length !== 2) {
  console.error("FAIL mode.oneOf[0].enum 丢失:", JSON.stringify(mcp.parameters.properties.mode.oneOf[0]));
  process.exit(1);
}
// 断言 3：anyOf 合并为 oneOf
if (!mcp.parameters.properties.nested_any.oneOf || mcp.parameters.properties.nested_any.oneOf.length !== 2) {
  console.error("FAIL nested_any anyOf→oneOf 合并失败:", JSON.stringify(mcp.parameters.properties.nested_any));
  process.exit(1);
}
// 断言 4：description / required / items 保留
if (mcp.parameters.properties.filters.description !== "filter list") {
  console.error("FAIL description 丢失");
  process.exit(1);
}
if (mcp.parameters.properties.filters.items.required?.[0] !== "opts") {
  console.error("FAIL 嵌套 required 丢失");
  process.exit(1);
}
if (mcp.parameters.properties.plain_tool) {
  console.error("FAIL plain_tool 不应出现在 mcp 的 properties 里");
  process.exit(1);
}
// 断言 5：plain 工具保留
if (decls[1].name !== "plain_tool" || decls[1].parameters.properties.q.description !== "query") {
  console.error("FAIL plain_tool 被误伤:", JSON.stringify(decls[1]));
  process.exit(1);
}
// 断言 6：strict 已从 function 级删除
if ("strict" in mcp) {
  console.error("FAIL function.strict 未删除");
  process.exit(1);
}

console.log("ALL PASS ✅");
console.log("发送的 function_declarations[0].parameters:");
console.log(JSON.stringify(mcp.parameters, null, 2));