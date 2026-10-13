import type { ComponentProps } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function ChatGptUsageButton(props: Omit<ComponentProps<typeof Button>, "onClick">) {
  return (
    <Button
      variant="ghost-muted"
      size="sm"
      {...props}
      render={<a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" />}
    >
      Manage usage
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
