import { NextResponse } from "next/server";

import { detectCatpawSession } from "open-sse/shared/miaoshou/credentials.js";

/**
 * GET /api/oauth/miaoshou/auto-import
 *
 * Read the signed-in 妙手 (CatPaw) desktop app session from this machine:
 *   1. `CATPAW_CONFIG_CONTENT` env of a running catpaw-cli / 妙手 process
 *   2. ~/.meituan-catpaw/auth.json (written by the CLI's bootstrap)
 *
 * The token is validated against the catalog before it is reported, so a stale
 * local file cannot masquerade as a live session. Nothing is persisted here —
 * the client posts what it receives to /api/oauth/miaoshou/import.
 */
export async function GET() {
  try {
    const result = await detectCatpawSession();
    if (!result.found) {
      const status = result.inconclusive ? 200 : 404;
      return NextResponse.json(
        {
          found: false,
          error: result.error,
          inconclusive: result.inconclusive === true,
        },
        { status },
      );
    }

    return NextResponse.json({
      found: true,
      accessToken: result.token,
      source: result.source,
      modelCount: result.models?.length || 0,
    });
  } catch (error) {
    console.log("妙手 auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read 妙手 credentials" },
      { status: 500 },
    );
  }
}
