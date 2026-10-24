// The codex STT conversion tests exercise the real ffmpeg path. A bare
// environment without the binary fails them with "ffmpeg is required" — skip
// instead (CI installs ffmpeg explicitly; see .github/workflows/test.yml).
import { spawnSync } from "node:child_process";

export const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error == null;
export const itFfmpeg = hasFfmpeg ? it : it.skip;
