import { NextResponse } from "next/server";
import { deleteCustomModelsByProvider, deleteModelAliasesForProvider, deleteProviderConnectionsByProvider, deleteProviderNode, enableModels, getProviderConnections, getProviderNodeById, getProviderNodes, updateProviderConnection, updateProviderNode } from "@/models";
import { RESERVED_PROVIDER_PREFIXES } from "@/sse/services/model.js";
import { getProviderByAlias } from "@/shared/constants/providers";

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, baseUrl } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (!baseUrl?.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl = baseUrl.trim();
    
    // Sanitize Base URL for Anthropic Compatible
    if (node.type === "anthropic-compatible") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }
    }

    // Sanitize Base URL for Custom Embedding (strip trailing slash and /embeddings)
    if (node.type === "custom-embedding") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => (
      updateProviderConnection(connection.id, {
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: prefix.trim(),
          apiType: node.type === "openai-compatible" ? apiType : undefined,
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
        }
      })
    )));

    return NextResponse.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// A prefix joins the cascade only while it is this node's own name. node.prefix
// is user-typed and checked only for "not empty", so it can coincide with a
// built-in provider ("ollama" as a compatible-node prefix is a configuration
// people create) or with a sibling node's. Claims are checked along the three
// paths a name reaches the wire: RESERVED for request-time "<name>/model"
// resolution (getProviderByAlias adds the uiAlias spelling RESERVED omits), a
// sibling node's prefix for nodes with no connection yet — the custom-embedding
// card keys its rows on prefix alone — and a connection's prefix for what
// /v1/models advertises. Cascading under a claimed name would delete a live
// provider's models and shortcuts; leaving a row behind is the cheaper mistake.
function prefixStillClaimed(prefix, nodeId, nodes, connections) {
  if (RESERVED_PROVIDER_PREFIXES.has(prefix) || getProviderByAlias(prefix)) return true;
  const claimed = (name) => String(name || "").trim() === prefix;
  return nodes.some((node) => node.id !== nodeId && claimed(node.prefix))
    || connections.some((conn) => conn.provider !== nodeId && claimed(conn.providerSpecificData?.prefix));
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    const nodeNames = [id];
    const prefix = node.prefix?.trim();
    if (prefix) {
      const [nodes, connections] = await Promise.all([getProviderNodes(), getProviderConnections()]);
      if (!prefixStillClaimed(prefix, id, nodes, connections)) nodeNames.push(prefix);
    }

    // Everything kv-scoped to this node must die with it, or the combo picker
    // shows ghost groups and shortcuts dangle on a dead provider. The node row
    // goes last: a cascade that throws mid-way would otherwise leave the
    // orphans behind an id that now 404s, with no way to retry.
    await deleteProviderConnectionsByProvider(id);
    await deleteCustomModelsByProvider(nodeNames);
    await deleteModelAliasesForProvider(nodeNames);
    for (const name of nodeNames) await enableModels(name, []); // empty ids = drop the whole row
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
