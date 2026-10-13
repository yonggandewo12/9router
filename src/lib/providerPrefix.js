import { getProviderNodes } from "@/lib/db/index.js";
import { isReservedProviderName } from "@/shared/constants/providers";

// A node's prefix is the namespace its models are advertised under
// ("<prefix>/model") and the name a client then copies back into custom models,
// aliases and hidden lists. Two providers answering to one name cannot be told
// apart at request time, and deleting either cascades over rows the other still
// needs — so the collision is refused where the name is set, not discovered
// later in the data.
export async function findPrefixConflict(prefix, selfId = null) {
  const name = String(prefix || "").trim();

  if (isReservedProviderName(name)) {
    return `Prefix "${name}" is already a provider name — pick another`;
  }

  const clash = (await getProviderNodes())
    .find((node) => node.id !== selfId && String(node.prefix || "").trim() === name);
  if (clash) {
    return `Prefix "${name}" is already used by node "${clash.name}" — pick another`;
  }

  return null;
}
