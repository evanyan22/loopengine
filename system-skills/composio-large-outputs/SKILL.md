---
name: composio-large-outputs
description: How to retrieve a gateway tool's real output when its result says storedInFile is true instead of returning the data inline.
---

# Gateway tools with a large result

Some gateway tools (Composio-sourced ones in particular) return a small
pointer object instead of their real output when the actual result is
too large to return inline:

```
{
  "successful": true,
  "storedInFile": true,
  "tokenCount": 10234,
  "outputFilePath": "/tmp/.../SOME_TOOL_OUTPUT_xxxxx.json"
}
```

When you see `storedInFile: true` in a tool result, the real data is
**not** in that object — it's in the file at `outputFilePath`. Call
`read_file` with that exact path to retrieve the actual content before
answering. Don't guess at an answer, summarize from the pointer alone,
or claim you don't have the data — read the file first.
