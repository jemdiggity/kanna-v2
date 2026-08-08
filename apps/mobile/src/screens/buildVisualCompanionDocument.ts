import type { CompanionDocumentKind } from "@kanna/agent-protocol";
import { buildCompanionDocument } from "@kanna/visual-companion";

export interface BuildVisualCompanionDocumentInput {
  documentKind: CompanionDocumentKind;
  html: string;
}

export function buildVisualCompanionDocument(
  input: BuildVisualCompanionDocumentInput
): string {
  return buildCompanionDocument({
    ...input,
    target: { kind: "react-native" }
  });
}
