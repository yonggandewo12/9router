import { TRAE_ENTERPRISE_CONFIG } from "../constants/oauth.js";
import { createTraeProvider } from "./trae.js";

// Trae Enterprise — same device flow as consumer Trae, tenant console host.
export default createTraeProvider(TRAE_ENTERPRISE_CONFIG);
