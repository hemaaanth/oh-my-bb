# Podcast (experimental)

Podcast is an in-app voice control mode. Each BB project has a saved name,
voice, personality, and routing topics. A project speaker can read and direct
only that project's visible threads.

Open **Dispatch → Podcast → Start podcast**. Speak a project or person name,
then give an instruction. For example:

- “Website, ask the header thread to add a regression test.”
- “Compiler, what still needs my attention?”
- “Have Website start a thread to simplify the navigation.”
- “Hold the updates.” / “Resume updates.”

**Project people** edits the speakers and selects participating projects.
Changes take effect on the next call. A call supports up to 30 projects. The
thirteen built-in speech voices repeat beyond thirteen projects. Styles can
still differ. A typed instruction field is available during a call.

The existing Dispatch microphone shortcut, mute command, and stop controls
also control Podcast. Only one Dispatch or Podcast call can run at a time.
Leaving the Dispatch panel keeps the call running. Closing the page ends it.
A server lease expires after 90 seconds without a browser heartbeat.
Phone calls still use regular Dispatch.

## Control and updates

Speakers can list and read project threads, read actual conversation pages,
start threads, send instructions, rename threads, change a model, stop work,
and answer pending provider user questions. Stopping or changing a model
requires a proposed action followed by a separate spoken confirmation. A
thread is checked again before confirmation. Tool/permission approvals and
plugin-defined forms still use their existing BB controls.

Finished and failed turns and pending interactions create project updates.
They are delivered at the next pause, after the current user request.
Finishing a turn is not treated as proof that the whole task is complete.
An update can only read; it cannot start or steer work on its own.

Interrupting cancels obsolete answers and audio synthesis. It does not undo
an instruction already sent to an agent. An interrupted update remains
pending until it is played to the end. Updates coalesce per thread, persist
through reconnects for up to seven days, and rotate between projects at equal
priority. Failures and requests for input go before ordinary results.

The queue records notices only while Podcast is running. It does not provide
an inbox of every event that happened while you were away. Ask for a project
status or use Journal for that history.

## Context and isolation

The router gets project names, person names, routing topics, the last addressed
project, and the most recent speaker. It does not get thread text. Compound
instructions are split into project-specific clauses.

Each speaker has separate in-call context. All tool calls check project
ownership on the server. Hidden threads are excluded. The generic plugin CLI,
global thread search, screen contents from other projects, and global call
recall are not available to project speakers.

Journal is optional. The speaker can read its `read.show` RPC for a known,
validated thread. Dispatch does not install, enable, sync, or enrich Journal.
It does not feed Journal's global catch-up narrative or grouped work lists to
speakers. A missing Journal can be handled through live BB thread reads.
Current state and exact details should come from fresh thread output/history.

Per-project conversation context currently lasts for the call. The regular
Dispatch call ledger and its retention/forget controls store the transcript,
with project speaker labels. These mixed-call summaries are never used as a
project speaker's context. Pending work updates are a separate seven-day queue.

## Audio and usage

This first implementation uses the existing OpenAI API key:

- `gpt-live-transcribe` over WebRTC for streaming transcription;
- the saved Dispatch reasoning model for routing and project tools;
- `gpt-4o-mini-tts` for each project's spoken output.

The project API key stays on the server. A random call token binds Podcast
RPCs to the live call. It is kept in memory and is not persisted in the app.
The first speaker's answer is sent to the app while other selected projects
prepare theirs. Short MP3 utterances are currently buffered before playback.
Local microphone level detection commits a turn after 750 ms of silence.
Hardware calibration and real-world end-to-end latency still need live testing.
If a voice connection or microphone fails, end the call and start again.

Reasoning usage, speech characters, and audio bytes are recorded as
`podcast.usage` trace events. The existing GPT-Live per-minute dollar estimate
**does not include Podcast**. Consult provider usage for actual charges.

OpenAI currently documents `gpt-4o-mini-tts` as retiring on January 6, 2027.
This makes it a temporary prototype backend. Replace its speech transport
before that date; Mistral and ElevenLabs remain candidates. This implementation
does not claim to compare their voice quality or latency.

Official transport references:

- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime)
- [Speech API](https://developers.openai.com/api/docs/guides/text-to-speech)

## Development

The branch must pass package-local typecheck, tests, and build. Keep live
Dispatch registered to its normal checkout until this branch is reviewed and
merged. A successful build is not a live voice test. Do not point the live
plugin registration at this worktree to test it.
