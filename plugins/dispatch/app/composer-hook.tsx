// The composer hook (SPEC §6.1). It draws nothing. While mounted it registers
// this composer as the call's bindings, and its empty marker lets the pointer
// ghost find the composer. The footer pet is the call control.
import { useRef } from "react";
import { useBbContext, useComposer } from "@get-bb/plugin-sdk/app";
import { COMPOSER_MARKER } from "@/app/pointer-ghost/model.js";
import { useRegisterBindings, type ComposerBindings, type ScreenContext } from "@/voice/bindings.js";

/** Marks a submit as Dispatch's, for dispatch hooks that care. */
const SUBMIT_DATA = { source: "dispatch" } as const;

/** Lets the call read and write this composer's draft and send it. */
function useComposerBindings(): { context: ScreenContext; composer: ComposerBindings } {
  const composer = useComposer();
  const { projectId: routeProject } = useBbContext();
  const scope = composer.scope;
  const context: ScreenContext = {
    threadId: scope.kind === "new-thread" ? null : scope.threadId,
    projectId: scope.kind === "new-thread" ? scope.projectId ?? routeProject : routeProject,
    onNewThreadScreen: scope.kind === "new-thread",
  };
  // The handle is stable and always acts on the current draft.
  const bindings = useRef<ComposerBindings | null>(null);
  bindings.current ??= {
    draft: () => composer.draft,
    replace: (next) => composer.replace({ text: next.text, mentions: next.mentions }),
    submit: () => composer.submit({ experimental_data: SUBMIT_DATA }),
    focus: () => composer.focus(),
  };
  return { context, composer: bindings.current };
}

export function ComposerHook() {
  const { context, composer } = useComposerBindings();
  useRegisterBindings("composer", context, composer);
  return <span {...{ [COMPOSER_MARKER]: "" }} className="inline-flex items-center" />;
}
