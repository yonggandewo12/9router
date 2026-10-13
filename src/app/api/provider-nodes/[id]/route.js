import { NextResponse } from "next/server";
import { deleteCustomModelsByProvider, deleteModelAliasesForProvider, deleteProviderConnectionsByProvider, deleteProviderNode, enableModels, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/models";
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

// A prefix is what /v1/models advertises, so a client can only have copied
// "<prefix>/model" back while some provider still advertised it. A node
// advertises through its own connections; any other provider still holding the
// same name — a built-in id/alias, or a sibling node's connection — owns those
// rows, and deleting them would damage a provider that is alive. node.prefix is
// user-typed and unvalidated, so "ollama" as a compatible-node prefix is a real
// configuration, not a hypothetical.
function prefixStillClaimed(prefix, nodeId, connections) {
  if (getProviderByAlias(prefix)) return true;
  return connections.some((conn) => conn.provider !== nodeId
    && String(conn.providerSpecificData?.prefix || "").trim() === prefix);
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
      const connections = await getProviderConnections();
      if (!prefixStillClaimed(prefix, id, connections)) nodeNames.push(prefix);
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
