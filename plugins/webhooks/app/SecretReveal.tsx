// Shows a newly issued secret once. Nothing stores it; closing the box loses it.
import { useState } from "react";
import { experimental_copyToClipboard as copyToClipboard } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ResourceDetailPanel } from "@/components/ui/resource-list";
import type { AuthMode } from "../contract.js";

export function SecretReveal({ secret, authMode, onDone }: { secret: string; authMode: AuthMode; onDone: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const label = authMode === "bearer" ? "Bearer token" : "Signing secret";
  return (
    <ResourceDetailPanel className="p-4">
      <section aria-label={label} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">{label}</h2>
          <p className="text-xs leading-snug text-muted-foreground">
            Copy it now. It is not shown again.
          </p>
        </div>
        <ResourceDetailPanel surface="recessed">
          <code className="block select-all break-all px-3 py-2 font-mono text-xs leading-5 text-foreground">{secret}</code>
        </ResourceDetailPanel>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard({ text: secret }).then(setCopied)}>
            <Icon name={copied ? "Check" : "Copy"} aria-hidden className="size-3.5" />
            Copy
          </Button>
          <Button type="button" size="sm" onClick={onDone}>
            Done
          </Button>
          {copied === null ? null : (
            <span role="status" className="text-xs text-muted-foreground">
              {copied ? "Copied." : "Copy failed. Select the text instead."}
            </span>
          )}
        </div>
      </section>
    </ResourceDetailPanel>
  );
}
