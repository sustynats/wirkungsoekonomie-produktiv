import snapshot from "@/data/woek-reference-snapshot.json";
import { sdgPlusTargetReference } from "@/lib/normative/reference-registry";
import { sha256 } from "@/lib/review/privacy";

export function currentReferenceSnapshot() {
  const current = {
    ...snapshot,
    leading_references: snapshot.leading_references.map((reference) =>
      reference.reference_id === "SDG_SDGPLUS_REFERENCE"
        ? {
            ...reference,
            version: sdgPlusTargetReference.version,
            url: sdgPlusTargetReference.currentReferenceUrl,
            sha256: sha256(sdgPlusTargetReference)
          }
        : reference
    )
  };
  return { ...current, snapshot_hash: sha256(current) };
}

export function publicationIsBlockedByReferenceSnapshot() {
  return snapshot.status !== "READY";
}
