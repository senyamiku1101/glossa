export function renderMarkdown(src: string) {
  const escaped = escapeHtml(src);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${code}</code></pre>`;
  });
  const withInline = withCode
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return withInline
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
