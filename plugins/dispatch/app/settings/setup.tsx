import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { ICON, NAV_PANEL } from "../ids.js";
import { ReadinessSection } from "./readiness.js";

export function SetupGuide() {
  const navigate = useBbNavigate();
  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised" aria-hidden="true">
          <Icon name={ICON} className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">Set up Dispatch</h1>
          <p className="text-xs text-muted-foreground">Use voice in BB or on your phone.</p>
        </div>
      </header>
      <ReadinessSection showSetupLink={false} />
      <section className="space-y-2 text-sm leading-relaxed">
        <h2 className="font-medium text-foreground">In-app voice</h2>
        <p>Add an OpenAI API key with GPT-Live access in Settings → Dispatch → Configuration. ChatGPT and Codex subscription tokens do not work.</p>
        <p className="text-muted-foreground">Save the key. Dispatch reloads when no call is active. Then use the Dispatch footer button or Mod+Shift+H and allow microphone access. No other plugin is needed.</p>
      </section>
      <section className="space-y-2 text-sm leading-relaxed">
        <h2 className="font-medium text-foreground">Phone calls</h2>
        <p>Phone calls are optional. Add your Twilio Account SID, auth token, Twilio voice number, your phone number and OpenAI SIP project id in Dispatch settings.</p>
        <p className="text-muted-foreground">Install Webhooks separately. Configure a signed OpenAI incoming-call endpoint that targets Dispatch, then allow Dispatch under Webhooks → Oh My BB. Webhooks owns the public HTTPS route and endpoint authentication. Dispatch does not install or enable it.</p>
        <a className="inline-block text-foreground underline underline-offset-4" href="https://github.com/hemaaanth/oh-my-bb/blob/main/plugins/dispatch/docs/phone-calls.md" target="_blank" rel="noreferrer">Phone setup instructions</a>
      </section>
      <section className="space-y-2 text-sm leading-relaxed">
        <h2 className="font-medium text-foreground">Storage and cost</h2>
        <p className="text-muted-foreground">Saved credentials stay on the server. In-app audio goes directly to OpenAI. Voice time is estimated at $0.05 per minute, plus reasoning tokens and any Twilio minutes. Call memory and retention are controlled in Dispatch settings.</p>
      </section>
      <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel(NAV_PANEL.path)}>Back to console</Button>
    </div>
  );
}
