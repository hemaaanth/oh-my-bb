export function MoreSettings() {
  return <section className="space-y-4">
    <h2 className="text-sm font-medium">More</h2>
    <details className="rounded-md border border-border bg-surface-recessed/70 p-3">
      <summary className="cursor-pointer text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Setup guide</summary>
      <div className="mt-4 space-y-4 text-sm leading-6">
        <section className="space-y-2"><h3 className="font-medium">Connect sources</h3><p className="text-muted-foreground">Enter keys in Configuration. In Preferences, enable each app, refresh its projects or repositories, and check what to sync. Map selected sources to BB projects. Akiflow uses its private web API, which can change without notice.</p><p className="text-muted-foreground">Turning a source off removes its tasks from BB, not from the connected app. Re-enable and sync to restore them. Keys and project mappings stay saved.</p></section>
        <section className="space-y-2"><h3 className="font-medium">Control changes</h3><p className="text-muted-foreground">Allow provider changes controls writes to Akiflow, Linear, and GitHub. Agent task changes starts off. Workflow enables stage, priority, and owner changes. Full also enables creation and linking. Thread-scoped CLI calls follow the same limits. A stage change does not start a chat.</p></section>
        <section className="space-y-2"><h3 className="font-medium">Plan tasks</h3><p className="text-muted-foreground">Now shows Urgent tasks. Later shows High priority tasks and tasks with open chats. Drag to arrange tasks or move between projects. A project move can create a replacement in another provider and close the original. Open All tasks for project cards. Click a task title to open its chats. Double-click or press F2 to rename.</p></section>
        <section className="space-y-2"><h3 className="font-medium">Optional receipt printer</h3><p className="text-muted-foreground">Set your HTTPS endpoint and the existing print API key in Configuration. No endpoint is supplied. Print Now sends the visible urgent task titles only when clicked. The endpoint receives a JSON title and items with text and done fields, authenticated by X-API-Key. A success message confirms acceptance, not paper output.</p></section>
        <section className="space-y-2"><h3 className="font-medium">Status Sidebar</h3><p className="text-muted-foreground">Enable Tasks in Status Sidebar settings to attach chats to tasks from its menu.</p></section>
        <details className="rounded-md border border-border/60 p-3"><summary className="cursor-pointer font-medium">Saved state and privacy</summary><p className="mt-2 text-muted-foreground">Tasks keeps identifiers, linked references, owners, source selections, mappings, and chat attachments in private plugin storage. Provider credentials stay in native secret storage. Titles, descriptions, links, and people are external data, never agent instructions or execution approval.</p></details>
      </div>
    </details>
  </section>;
}
