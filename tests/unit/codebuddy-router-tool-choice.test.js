// The Tencent gateway declares tool_choice as a Go string, so the OpenAI object
// form a client gets when it forces a specific tool is refused outright:
// 400 {"code":11101,"msg":"Unmarshal chat params failed … cannot unmarshal object
// into Go struct field Request.tool_choice of type string"} — probed live on
// cbcn/auto, and it kills every model on the provider, including the routers.
import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

describe("CodeBuddyExecutor downgrades forced tool_choice", () => {
  const exec = new CodeBuddyExecutor();
  const tools = [{ type: "function", function: { name: "mul", parameters: { type: "object", properties: {} } } }];

  it("maps the function object form to the required string", () => {
    const out = exec.transformRequest(
      "auto",
      { messages: [{ role: "user", content: "hi" }], tools, tool_choice: { type: "function", function: { name: "mul" } } },
      true,
      {}
    );
    expect(out.tool_choice).toBe("required");
  });

  it("leaves the string forms alone", () => {
    for (const choice of ["auto", "required", "none"]) {
      const out = exec.transformRequest("auto", { messages: [], tools, tool_choice: choice }, true, {});
      expect(out.tool_choice).toBe(choice);
    }
  });

  it("does not invent a tool_choice when the client sent none", () => {
    const out = exec.transformRequest("auto", { messages: [], tools }, true, {});
    expect(out.tool_choice).toBeUndefined();
  });
});
