import { NextResponse } from "next/server";

import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { extractMiaoshouToken, probeCatpawToken } from "open-sse/shared/miaoshou/credentials.js";

/**
 * POST /api/oauth/miaoshou/import
 *
 * Save a 妙手 (CatPaw) Passport session as a provider connection.
 * Body: { accessToken, name? }
 *
 * The token is probed against the model catalog first: a dead token must not
 * create a connection that fails on the first chat. An inconclusive probe
 * (network down) still stores it, marked as untested, so a working local setup
 * is not blocked by a flaky lookup.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    // Same parser the executor runs on every turn (raw token, cookie header,
    // or a cookie-editor JSON blob) — a paste that connects here is exactly
    // the paste that works at runtime.
    const accessToken = extractMiaoshouToken({ apiKey: typeof body?.accessToken === "string" ? body.accessToken : "" });
    if (!accessToken) {
      return NextResponse.json({ error: "X-Passport-Token is required" }, { status: 400 });
    }

    const probe = await probeCatpawToken(accessToken);
    if (!probe.ok && !probe.inconclusive) {
      return NextResponse.json({ error: probe.error || "妙手 session is not valid" }, { status: 401 });
    }

    const name = (typeof body?.name === "string" && body.name.trim()) || "妙手";

    const connections = (await getProviderConnections()).filter(
      (c) => c.provider === "miaoshou" && c.authType === "cookie",
    );

    // One connection per token: re-importing the same session must refresh the
    // stored credential instead of piling up duplicates.
    const sameToken = connections.find((c) => c.apiKey === accessToken);
    if (sameToken) {
      const updated = await updateProviderConnection(sameToken.id, {
        apiKey: accessToken,
        testStatus: probe.ok ? "active" : "unknown",
        lastError: probe.ok ? null : probe.error || null,
        lastErrorAt: probe.ok ? null : new Date().toISOString(),
      });
      return NextResponse.json({
        success: true,
        updated: true,
        connection: { id: updated.id, provider: updated.provider, name: updated.name },
      });
    }

    // A DIFFERENT token from the same machine is almost always a re-login: the
    // previous connection's Passport token is now dead, and this import is its
    // replacement. Refresh the first connection whose old token no longer
    // validates instead of stacking a duplicate that 401s on its first turn.
    // A still-live old token means a genuinely second account — create new.
    let refreshTarget = null;
    for (const c of connections) {
      const oldProbe = await probeCatpawToken(c.apiKey);
      if (!oldProbe.ok && !oldProbe.inconclusive) {
        refreshTarget = c;
        break;
      }
    }
    if (refreshTarget) {
      const updated = await updateProviderConnection(refreshTarget.id, {
        apiKey: accessToken,
        testStatus: probe.ok ? "active" : "unknown",
        lastError: probe.ok ? null : probe.error || null,
        lastErrorAt: probe.ok ? null : new Date().toISOString(),
      });
      return NextResponse.json({
        success: true,
        updated: true,
        rotated: true,
        connection: { id: updated.id, provider: updated.provider, name: updated.name },
      });
    }

    const connection = await createProviderConnection({
      provider: "miaoshou",
      authType: "cookie",
      apiKey: accessToken,
      name,
      priority: 1,
      providerSpecificData: { source: "local-import" },
      isActive: true,
      testStatus: probe.ok ? "active" : "unknown",
    });

    return NextResponse.json({
      success: true,
      connection: { id: connection.id, provider: connection.provider, name: connection.name },
    });
  } catch (error) {
    if (error?.code === "PROVIDER_NAME_CONFLICT") {
      return NextResponse.json(
        { error: error.message, code: error.code, existingId: error.existingId },
        { status: 409 },
      );
    }
    console.log("妙手 import token error:", error);
    return NextResponse.json({ error: error.message || "Import failed" }, { status: 500 });
  }
}
