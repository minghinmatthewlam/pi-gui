# Add to Chat

Users select text in a transcript message, attach an optional comment, and send those notes with their next message.

## Sub-features

- `annotate-select`: select text inside one message and add it with the Add to Chat button or shortcut.
- `annotate-copy`: copy the selected text with the Copy button beside Add to Chat.
- `annotate-comment`: write, edit or remove the comment on an annotation.
- `annotate-send`: send the notes ahead of the typed message and see them on the sent message.

## How to get to it (user POV)

- Select text inside one transcript message. A pill appears over the selection with "Copy" (⌘ C, Ctrl C elsewhere) and "Add to Chat" (⌘ L, Ctrl L elsewhere); each shortcut does the same as its button.
- Copy puts the trimmed quote on the clipboard, shows "Copied" for about a second, and keeps the selection, so Add to Chat still works on it. The ⌘ C shortcut is the normal Edit menu copy of the raw selection, so it can keep whitespace, or row text from a drag that runs past the message, that the button leaves out.
- A comment box opens (`Annotation comment`, placeholder "Add an optional comment…"). Enter or leaving the box saves; Escape closes without saving the comment (the annotation stays); `Remove annotation` deletes it.
- Numbered markers in the transcript (`Edit annotation N`) reopen the box.
- An "N annotations" chip sits above the composer. Hovering or focusing it lists each quote and comment, with `Remove annotation N` buttons.
- On send, each quote and note goes before the typed message. The sent message shows them as collapsible quotes with notes, and a saved thread reads them back the same way when reopened.
- A queued message carrying annotations reads "<text> · N annotations" and cannot be edited; see [follow-ups](follow-ups.md).
- Unsent annotations live in memory only; quitting the app loses them.

## Driving it with Playwright

Preconditions: isolated profile with a fixture thread that has assistant text. No provider is needed in core.

- **Core regression:** `pnpm --filter @pi-gui/desktop run test:e2e:runner -- apps/desktop/tests/core/transcript-annotations.spec.ts`. It copies a selection with the Copy button and reads the Electron clipboard, adds selections with comments and sends them before the message, edits and removes them from markers and the chip, gives back the typed text and annotation when a send fails, checks that a multi-line drag running past the text still adds its lines, and keeps the Copy and Add to Chat buttons inside a narrow window when the selection ends at its right edge. It launches with a seeded transcript that already holds an annotated message, which proves saved annotations read back as quotes; no spec sends and then relaunches.
- **Prompt shape:** unit `apps/desktop/tests/unit/annotation-prompt.spec.ts` checks the `<annotation><quote>…</quote><note>…</note></annotation>` blocks.
- No `prove.sh` lane selects transcript text, and there is no real-provider spec. A conversation pass says nothing about Add to Chat.

## Gotchas

- Selection uses the real DOM selection; drive it with mouse drags or a selection range, not by typing into the transcript.
