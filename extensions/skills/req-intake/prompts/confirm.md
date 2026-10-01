# Requirement confirmation prompt

You are preparing a requirement document for human confirmation. The human
confirms CONTENT, not a step name or a file path.

## Steps

1. Take the requirement document produced by the `intake` action.
2. Compute the SHA-256 of its canonical text: the YAML document exactly as it
   will be stored, with no surrounding prose and with a single trailing
   newline. Render it as `sha256:<64 lowercase hex characters>`.
3. Present, in this order:
   - the full requirement document;
   - its `sha256:<...>` digest;
   - a numbered list of every `AMB-nnn` entry with its question, its bounded
     `options`, its `default` and its `blocking` flag.
4. Ask the human to record, for each `AMB-nnn`, the chosen option. A choice
   must be one of the listed options; if the human names something outside the
   list, add it as a new option only if the human explicitly asks for a new
   decision, then recompute the digest.
5. Write the chosen option into the corresponding `AMB-nnn` entry as
   `chosen: "<option>"`, leave all other text unchanged, and report the new
   `sha256:<...>` digest of the updated document.

## Output

Emit the updated YAML document, the digest, and one line per ambiguity:
`AMB-nnn: <chosen option>`. If any `blocking: true` ambiguity has no chosen
option, say so explicitly and stop: an unconfirmed requirement must not move
forward.

Emit nothing else.
