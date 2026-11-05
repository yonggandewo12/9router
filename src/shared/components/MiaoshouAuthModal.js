"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

/**
 * 妙手 (CatPaw) connect modal.
 *
 * 妙手 is a desktop app, not a web dashboard: the credential is the Meituan
 * Passport token the app already holds locally. Two ways in:
 *   1. Auto-detect the signed-in desktop app (server reads the running app's
 *      env / ~/.meituan-catpaw/auth.json, validates it, then imports)
 *   2. Paste the token manually (DevTools → Application → Cookies →
 *      X-Passport-Token on catpaw.meituan.com)
 */
export default function MiaoshouAuthModal({ isOpen, onSuccess, onClose }) {
  const [phase, setPhase] = useState("detecting"); // detecting | found | manual | importing | success | error
  const [detected, setDetected] = useState(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const importToken = useCallback(
    async (value, label) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/oauth/miaoshou/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: value, name: label }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Import failed");
        setPhase("success");
        setTimeout(() => {
          onSuccess?.();
          onClose?.();
        }, 700);
      } catch (err) {
        setError(err.message || "Import failed");
        setPhase(value === detected?.accessToken ? "found" : "manual");
      } finally {
        setBusy(false);
      }
    },
    [detected, onSuccess, onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    (async () => {
      // State resets live inside the async body: running them after an await
      // keeps this out of the synchronous effect body (react-hooks lint).
      await Promise.resolve();
      if (cancelled) return;
      setPhase("detecting");
      setError(null);
      setDetected(null);
      setToken("");
      try {
        // 35s > the route's worst case (ps 8s + 12s probe per source, two
        // sources ≈ 32s): a 15s cut made a slow-but-working detection look
        // like "not found" while the server was still mid-probe.
        const res = await fetch("/api/oauth/miaoshou/auto-import", {
          signal: AbortSignal.timeout(35000),
        });
        const data = await res.json();
        if (cancelled) return;
        if (data?.found && data.accessToken) {
          setDetected(data);
          setPhase("found");
          return;
        }
        // The route reads host files, so the guard keeps it local (same as the
        // cursor/kiro/zed auto-imports). Say so instead of surfacing a bare
        // "Unauthorized" that reads like a 妙手 problem.
        setError(
          res.status === 401 || res.status === 403
            ? "Auto-detect only works from this machine. Paste the token below instead."
            : data?.error || null,
        );
        setPhase("manual");
      } catch {
        if (!cancelled) setPhase("manual");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const close = () => {
    if (busy) return;
    onClose?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Connect 妙手 (CatPaw)">
      <div className="space-y-4">
        {phase === "detecting" && (
          <div className="flex items-center gap-3 py-6 text-sm text-text-muted">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
            Looking for a signed-in 妙手 app on this machine…
          </div>
        )}

        {phase === "found" && (
          <>
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm">
              <p className="font-medium text-text-primary">妙手 session found</p>
              <p className="mt-1 text-text-muted">
                {detected?.modelCount || 0} models available · source: {detected?.source}
              </p>
            </div>
            {error && <p className="text-xs text-red-500 break-words">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPhase("manual")} disabled={busy}>
                Use another token
              </Button>
              <Button
                size="sm"
                icon="check"
                onClick={() => importToken(detected?.accessToken, "妙手")}
                disabled={busy}
              >
                {busy ? "Importing…" : "Import session"}
              </Button>
            </div>
          </>
        )}

        {phase === "manual" && (
          <>
            <p className="text-sm text-text-muted">
              Sign in to the 妙手 desktop app, or paste its{" "}
              <code className="text-xs">X-Passport-Token</code> cookie
              (catpaw.meituan.com → DevTools → Application → Cookies).
            </p>
            {error && <p className="text-xs text-amber-600 break-words">{error}</p>}
            <Input
              label="X-Passport-Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="AgGEIIJc…"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                icon="login"
                onClick={() => importToken(token.trim(), "妙手")}
                disabled={busy || !token.trim()}
              >
                {busy ? "Validating…" : "Connect"}
              </Button>
            </div>
          </>
        )}

        {phase === "success" && (
          <div className="py-8 text-center">
            <div className="mb-3 text-5xl">✅</div>
            <p className="text-sm font-medium text-text-primary">妙手 connected</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

MiaoshouAuthModal.propTypes = {
  isOpen: PropTypes.bool,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func,
};
