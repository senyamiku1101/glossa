# Glossa principles

1. **One license, one tree.** AGPL-3.0-or-later. The GitHub (or other) repository that people clone is the source that is packed into the `.xpi`.
2. **No paid feature flags.** Reader chat, command tags, PDF RAG, and later outline/annotation/agent all ship in the same source, enabled for every user.
3. **No encrypted payloads.** Do not add `*.enc` modules, license servers, device quotas, or `new Function` loaders for hidden code.
4. **No `eval` in user tags.** Templates only interpolate `{{selection}}`, `{{abstract}}`, `{{related}}`, and similar fields.
5. **Bring your own model.** Glossa never requires a vendor account of ours. Users point at any OpenAI-compatible API.
6. **Document provenance.** Record the origin and license of any reused code or asset. Do not ship another plugin's binary payload or unverified source.
