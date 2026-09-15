# Why FramePipe exists

FFmpeg is a tool built for people who have read the man pages. That is the wrong shape for
an LLM agent, and the mismatch is the whole reason this project exists.

## The failure mode it fixes

Ask an agent to edit a video today and the loop usually goes like this:

1. It constructs a raw FFmpeg command from memory.
2. It gets the flag order, the filter-graph syntax, or the codec compatibility wrong.
3. FFmpeg writes a couple of hundred lines to stderr.
4. The agent parses the logs, guesses at the cause, and retries.
5. A few attempts later there may be an output file — with no confirmation of its
   resolution, whether the audio survived, or how long it actually is.

Every step of that is avoidable. The problem isn't that the model is bad at FFmpeg; it's
that FFmpeg's interface communicates through unstructured text, and the agent has to do
information extraction on a log file to find out what happened.

## The design position

**Treat the model as the caller, not the user.** A human says "clip the highlight reel." The
thing that has to turn that into an operation is the model, and it needs an interface built
for how it actually works: typed inputs, structured outputs, and errors it can branch on.

That leads to three concrete commitments:

**Typed input, no string assembly.** Every tool takes validated JSON. The agent never builds
a command line, so there is no flag-order class of bug.

**Structured output on success.** `trim` returns the output path, the resulting duration,
file size, codec, and a cost estimate. The agent knows what it produced without probing the
file afterward.

**Semantic errors, not stderr.** Failures return a code the agent can switch on —
`END_TIME_OUT_OF_RANGE`, `FILE_NOT_FOUND`, `NO_SUBTITLES` — with a message and a suggested
next step. Twenty-three distinct codes, so branching on the failure is a lookup rather than
a regex over log output.

## What that buys

The agent stops burning turns on retry loops and starts making decisions. `inspect_video`
tells it the duration before it asks for a trim, so the out-of-range error mostly stops
happening. `detect_silence` gives it real cut points instead of guesses. When something does
fail, the recovery path is in the response rather than inferred.

The cost estimates serve the same end: they let an agent reason about whether an operation is
worth doing before it runs, which matters when the caller is paying per render.

None of this is novel FFmpeg work — the underlying operations are ordinary. The contribution
is the interface boundary, and the argument that tools for agents should be designed for
agents rather than adapted from tools designed for people.
