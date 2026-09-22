import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { listCliFreeModels } from "open-sse/executors/opencode-cli.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    let data = filter(Array.isArray(raw) ? raw : []);
    // For OpenCode the "-free" suffix alone is not proof of servability — upstream
    // also lists ids the official CLI refuses. Keep only what the CLI itself
    // would serve; without a local CLI fall back to the suffix filter.
    if (type === "opencode-free") {
      const cliIds = await listCliFreeModels();
      if (cliIds) data = data.filter((m) => cliIds.has(m.id));
    }
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
