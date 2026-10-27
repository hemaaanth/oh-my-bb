import { useId, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import type { ChannelAgent } from "../../server/channels/contract";
import type { ChannelAutomation } from "../../server/channels/automation-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfigRow, ConfigSection, ErrorMessage, message } from "../shared/ui";

type ScheduleKind = "weekdays" | "daily" | "hourly" | "once" | "custom";

type ScheduleDraft = {
  kind: ScheduleKind;
  time: string;
  cron: string;
  timezone: string;
  at: string;
};

const localDate = (timestamp: number) => {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

function scheduleDraft(initial?: ChannelAutomation): ScheduleDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!initial) {
    return {
      kind: "weekdays",
      time: "09:00",
      cron: "0 9 * * 1-5",
      timezone,
      at: localDate(Date.now() + 3_600_000),
    };
  }
  if (initial.trigger.triggerType === "once") {
    return {
      kind: "once",
      time: "09:00",
      cron: "0 9 * * 1-5",
      timezone,
      at: localDate(initial.trigger.runAt),
    };
  }
  if (initial.trigger.cron === "0 * * * *") {
    return {
      kind: "hourly",
      time: "09:00",
      cron: initial.trigger.cron,
      timezone: initial.trigger.timezone,
      at: localDate(Date.now() + 3_600_000),
    };
  }
  const regular = /^(\d+) (\d+) \* \* (\*|1-5)$/.exec(
    initial.trigger.cron,
  );
  if (regular) {
    return {
      kind: regular[3] === "1-5" ? "weekdays" : "daily",
      time: `${regular[2]!.padStart(2, "0")}:${regular[1]!.padStart(2, "0")}`,
      cron: initial.trigger.cron,
      timezone: initial.trigger.timezone,
      at: localDate(Date.now() + 3_600_000),
    };
  }
  return {
    kind: "custom",
    time: "09:00",
    cron: initial.trigger.cron,
    timezone: initial.trigger.timezone,
    at: localDate(Date.now() + 3_600_000),
  };
}

export function scheduleDescription(automation: ChannelAutomation) {
  if (automation.trigger.triggerType === "once")
    return `Once · ${new Date(automation.trigger.runAt).toLocaleString()}`;
  const [minute, hour, day, month, weekday] = automation.trigger.cron
    .trim()
    .split(/\s+/);
  if (
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    day === "*" &&
    month === "*" &&
    ["*", "1-5"].includes(weekday ?? "")
  ) {
    return `${weekday === "1-5" ? "Weekdays" : "Every day"} at ${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")} · ${automation.trigger.timezone}`;
  }
  if (automation.trigger.cron === "0 * * * *")
    return `Every hour · ${automation.trigger.timezone}`;
  return `Custom (${automation.trigger.cron}) · ${automation.trigger.timezone}`;
}

export function AutomationEditor({
  channelId,
  agents,
  initial,
  onSaved,
  onCancel,
}: {
  channelId: string;
  agents: ChannelAgent[];
  initial?: ChannelAutomation;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const controls = useId();
  const initialSchedule = useMemo(() => scheduleDraft(initial), [initial]);
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentId, setAgentId] = useState(
    initial?.agentId ?? agents[0]?.id ?? "",
  );
  const [kind, setKind] = useState<ScheduleKind>(initialSchedule.kind);
  const [time, setTime] = useState(initialSchedule.time);
  const [cron, setCron] = useState(initialSchedule.cron);
  const [timezone, setTimezone] = useState(initialSchedule.timezone);
  const [at, setAt] = useState(initialSchedule.at);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID()).current;
  const baseline = useRef({
    name: initial?.name ?? "",
    prompt: initial?.prompt ?? "",
    agentId: initial?.agentId ?? agents[0]?.id ?? "",
    ...initialSchedule,
    enabled: false,
  }).current;
  const dirty =
    name !== baseline.name ||
    prompt !== baseline.prompt ||
    agentId !== baseline.agentId ||
    kind !== baseline.kind ||
    time !== baseline.time ||
    cron !== baseline.cron ||
    timezone !== baseline.timezone ||
    at !== baseline.at ||
    enabled !== baseline.enabled;
  const invalid =
    !name.trim() ||
    !prompt.trim() ||
    (!initial && !agentId) ||
    (kind === "once" && Number.isNaN(new Date(at).getTime())) ||
    (kind !== "once" && !timezone.trim()) ||
    (kind === "custom" && !cron.trim());

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || invalid || !dirty) return;
        setPending(true);
        setError(null);
        try {
          const [hour, minute] = time.split(":").map(Number);
          const trigger = kind === "once"
            ? {
                triggerType: "once" as const,
                runAt: new Date(at).getTime(),
              }
            : {
                triggerType: "schedule" as const,
                cron: kind === "custom"
                  ? cron
                  : kind === "hourly"
                    ? "0 * * * *"
                    : `${minute} ${hour} * * ${kind === "weekdays" ? "1-5" : "*"}`,
                timezone,
              };
          if (initial) {
            await rpc.call("automationUpdate", {
              channelId,
              automationId: initial.id,
              name,
              prompt,
              trigger,
            });
          } else {
            await rpc.call("automationCreate", {
              channelId,
              agentId,
              name,
              prompt,
              trigger,
              enabled,
              requestId,
            });
          }
          onSaved();
        } catch (cause) {
          setError(message(cause));
        } finally {
          setPending(false);
        }
      }}
    >
      <ConfigSection title="Automation">
        <ConfigRow label="Name" htmlFor={`${controls}-name`}>
          <Input
            id={`${controls}-name`}
            value={name}
            required
            maxLength={120}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </ConfigRow>
        {!initial ? (
          <ConfigRow label="Agent" htmlFor={`${controls}-agent`}>
            <select
              id={`${controls}-agent`}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={agentId}
              disabled={pending}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  @{agent.handle} · {agent.name}
                </option>
              ))}
            </select>
          </ConfigRow>
        ) : null}
        <ConfigRow label="Task" htmlFor={`${controls}-prompt`}>
          <Textarea
            id={`${controls}-prompt`}
            className="min-h-28 resize-y"
            value={prompt}
            required
            maxLength={8_000}
            disabled={pending}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </ConfigRow>
      </ConfigSection>
      <ConfigSection title="Schedule">
        <ConfigRow label="Repeat" htmlFor={`${controls}-kind`}>
          <select
            id={`${controls}-kind`}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={kind}
            disabled={pending}
            onChange={(event) => setKind(event.target.value as ScheduleKind)}
          >
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
            <option value="hourly">Every hour</option>
            <option value="once">Once</option>
            <option value="custom">Custom cron</option>
          </select>
        </ConfigRow>
        {kind === "once" ? (
          <ConfigRow label="Date and time" htmlFor={`${controls}-at`}>
            <Input
              id={`${controls}-at`}
              type="datetime-local"
              required
              value={at}
              disabled={pending}
              onChange={(event) => setAt(event.target.value)}
            />
          </ConfigRow>
        ) : (
          <>
            {kind === "daily" || kind === "weekdays" ? (
              <ConfigRow label="Time" htmlFor={`${controls}-time`}>
                <Input
                  id={`${controls}-time`}
                  type="time"
                  required
                  value={time}
                  disabled={pending}
                  onChange={(event) => setTime(event.target.value)}
                />
              </ConfigRow>
            ) : null}
            {kind === "custom" ? (
              <ConfigRow label="Cron expression" htmlFor={`${controls}-cron`}>
                <Input
                  id={`${controls}-cron`}
                  value={cron}
                  required
                  disabled={pending}
                  onChange={(event) => setCron(event.target.value)}
                />
              </ConfigRow>
            ) : null}
            <ConfigRow label="Timezone" htmlFor={`${controls}-timezone`}>
              <Input
                id={`${controls}-timezone`}
                value={timezone}
                required
                disabled={pending}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </ConfigRow>
          </>
        )}
        {!initial ? (
          <ConfigRow
            label="Start enabled"
            hint="New schedules stay paused unless you enable them here."
          >
            <Switch
              checked={enabled}
              disabled={pending}
              onCheckedChange={setEnabled}
            />
          </ConfigRow>
        ) : null}
      </ConfigSection>
      <ErrorMessage error={error} />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || invalid || !dirty}>
          {pending
            ? "Saving…"
            : initial
              ? "Save automation"
              : "Create automation"}
        </Button>
      </div>
    </form>
  );
}
