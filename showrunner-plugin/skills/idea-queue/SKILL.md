---
name: idea-queue
description: The person's idea queue for this task, kept in the Herdr app's Ideas panel. Use it when they ask you to work through their ideas or the queue, ask what is queued, or ask you to queue, park or keep something for later.
---

The person adds ideas for this task in the Ideas panel while you are busy with something else.
You reach the same queue through the `showrunner` CLI (it finds this session's task by itself):

```sh
showrunner ideas list                 # the queue, numbered, with each idea's id
showrunner ideas start <id>           # you are on it: the panel shows that
showrunner ideas done <id>            # finished: it leaves the queue
showrunner ideas add "<idea>" ...     # queue ideas for later, one argument each
```

**Working through the queue.** Read it, decide the order yourself (what unblocks what, related
changes together, small and safe ones early unless something is urgent), say the order and why in
a line or two, then do them one at a time: `start` as you begin one, `done` once it is finished.
Ask before starting one that is unclear. Leave out ideas marked as sent on their own: they come
to you as prompts of their own. Read the list again after each idea; the person may add more.

**Queuing for later.** When the person asks you to keep something for later, add it with
`ideas add`. Write each idea so it stands on its own: what to do and why, enough to act on in a
later session without this conversation. Don't start on them: they wait until the person sends
one or asks you to work through the queue.
