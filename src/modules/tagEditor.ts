import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getTags, resetTags, saveTags, type CommandTag } from "./tags";

const ref = config.addonRef;

/** Command tag list in the settings pane. */
export function initTagEditor(doc: Document) {
  doc.getElementById(`${ref}-tag-add`)?.addEventListener("click", () => {
    const tags = getTags();
    tags.push({
      name: getString("tag-new-name"),
      color: "#0EA293",
      template: "{{input}}",
    });
    saveTags(tags);
    renderTagEditor(doc);
  });
  doc.getElementById(`${ref}-tag-reset`)?.addEventListener("click", () => {
    resetTags();
    renderTagEditor(doc);
  });
  renderTagEditor(doc);
}

function renderTagEditor(doc: Document) {
  const host = doc.getElementById(`${ref}-tag-list`);
  if (!host) return;
  host.replaceChildren();
  const tags = getTags();
  tags.forEach((tag, index) => {
    const update = (patch: Partial<CommandTag>) => {
      tags[index] = { ...tags[index], ...patch };
      saveTags(tags);
    };
    ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: "html",
        classList: ["glossa-tag-row"],
        children: [
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-field"],
            children: [
              {
                tag: "input",
                namespace: "html",
                attributes: { type: "color", title: getString("tag-color") },
                properties: { value: tag.color },
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) =>
                      update({ color: (ev.target as HTMLInputElement).value }),
                  },
                ],
              },
              {
                tag: "input",
                namespace: "html",
                attributes: {
                  type: "text",
                  placeholder: getString("tag-name"),
                },
                properties: { value: tag.name },
                styles: { flex: "1" },
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) => {
                      const box = ev.target as HTMLInputElement;
                      const name = box.value.trim();
                      // A nameless tag would be dropped on load; keep the old one.
                      if (name) update({ name });
                      else box.value = tags[index].name;
                    },
                  },
                ],
              },
              {
                tag: "button",
                namespace: "html",
                properties: { textContent: getString("tag-delete") },
                listeners: [
                  {
                    type: "click",
                    listener: () => {
                      tags.splice(index, 1);
                      saveTags(tags);
                      renderTagEditor(doc);
                    },
                  },
                ],
              },
            ],
          },
          {
            tag: "textarea",
            namespace: "html",
            classList: ["glossa-code"],
            attributes: { rows: "5", placeholder: getString("tag-template") },
            properties: { value: tag.template },
            listeners: [
              {
                type: "change",
                listener: (ev: Event) =>
                  update({
                    template: (ev.target as HTMLTextAreaElement).value,
                  }),
              },
            ],
          },
        ],
      },
      host,
    );
  });
}
