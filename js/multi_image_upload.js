import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

async function uploadOneImage(file) {
  const body = new FormData();
  body.append("image", file, file.name);
  // ComfyUI core route: /upload/image
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Upload failed (${resp.status}): ${txt}`);
  }
  return await resp.json();
}

function toInputName(uploadJson) {
  // ComfyUI typically returns { name, subfolder, type } for uploads.
  // We store something that folder_paths.get_annotated_filepath can resolve.
  // If subfolder is present, include it.
  const name = uploadJson.name ?? "";
  const sub = uploadJson.subfolder ?? "";
  const joined = sub ? `${sub}/${name}` : name;

  // Annotate as [input] so backend can resolve even if user input dir changes.
  return `${joined} [input]`;
}

app.registerExtension({
  name: "multiimage.loader.widget",

  getCustomWidgets() {
    return {
      MULTI_IMAGE_UPLOAD: (node, inputName /*, inputData, app */) => {
        // This widget's "value" will be serialized into the workflow.
        const w = node.addWidget("text", inputName, "[]", () => {});
        w.serialize = true;

        const minNodeWidth = 360;
        const minNodeHeight = 240;

        // Keep a JS-side list too.
        let filesValue = [];

        // File input (multi)
        const fileInput = el("input", {
          type: "file",
          accept: "image/*",
          multiple: "multiple",
          style: { display: "none" },
          onchange: async () => {
            const files = Array.from(fileInput.files || []);
            await handleFiles(files);
            fileInput.value = "";
          },
        });
        document.body.appendChild(fileInput);

        // UI container
        const drop = el("div", {
          style: {
            width: "100%",
            boxSizing: "border-box",
            padding: "8px",
            border: "2px dashed #666",
            borderRadius: "8px",
            fontSize: "12px",
            lineHeight: "1.2",
            userSelect: "none",
          },
          ondragover: (e) => {
            e.preventDefault();
            drop.style.borderColor = "#999";
          },
          ondragleave: (e) => {
            e.preventDefault();
            drop.style.borderColor = "#666";
          },
          ondrop: async (e) => {
            e.preventDefault();
            drop.style.borderColor = "#666";
            const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
            await handleFiles(files);
          },
        }, [
          el("div", { style: { marginBottom: "6px", opacity: "0.9" } }, [
            document.createTextNode("Drop images here, or use the buttons below."),
          ]),
        ]);

        const btnRow = el("div", {
          style: { display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap" },
        });

        const chooseBtn = el("button", {
          type: "button",
          style: { padding: "4px 8px", cursor: "pointer" },
          onclick: () => fileInput.click(),
        }, [document.createTextNode("Choose images…")]);

        const clearBtn = el("button", {
          type: "button",
          style: { padding: "4px 8px", cursor: "pointer" },
          onclick: () => {
            filesValue = [];
            syncWidget();
            renderThumbs();
          },
        }, [document.createTextNode("Clear")]);

        btnRow.appendChild(chooseBtn);
        btnRow.appendChild(clearBtn);
        drop.appendChild(btnRow);

        const thumbs = el("div", {
          style: {
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "6px",
          },
        });
        drop.appendChild(thumbs);

        function syncWidget() {
          // Store as JSON so Python can parse it reliably.
          w.value = JSON.stringify(filesValue);
          node.setDirtyCanvas(true, true);
        }

        function renderThumbs() {
          thumbs.innerHTML = "";
          for (let i = 0; i < filesValue.length; i++) {
            const annotated = filesValue[i];

            // /view expects filename + type/subfolder; but annotated string includes " [input]"
            // We'll strip annotation for viewing and pass type=input.
            const raw = annotated.replace(/\s*\[input\]\s*$/, "");
            const url = api.apiURL(`/view?filename=${encodeURIComponent(raw)}&type=input`);

            const img = el("img", {
              src: url,
              style: {
                width: "100%",
                height: "70px",
                objectFit: "cover",
                borderRadius: "6px",
                border: "1px solid #444",
              },
              title: raw,
            });

            const del = el("button", {
              type: "button",
              style: {
                position: "absolute",
                top: "4px",
                right: "4px",
                padding: "2px 6px",
                cursor: "pointer",
                fontSize: "11px",
              },
              onclick: () => {
                filesValue.splice(i, 1);
                syncWidget();
                renderThumbs();
              },
            }, [document.createTextNode("×")]);

            const cell = el("div", {
              style: { position: "relative" },
            }, [img, del]);

            thumbs.appendChild(cell);
          }

          // Expand node height a bit based on how many images we show
          const rows = Math.ceil(filesValue.length / 3);
          const extra = rows ? (rows * 78) : 0;
          node.size[1] = Math.max(node.size[1], minNodeHeight + extra);
          node.setDirtyCanvas(true, true);
        }

        async function handleFiles(files) {
          if (!files.length) return;

          // Basic status text
          const oldText = drop.firstChild?.textContent;
          if (drop.firstChild) drop.firstChild.textContent = `Uploading ${files.length} image(s)…`;

          try {
            for (const f of files) {
              const up = await uploadOneImage(f);
              const annotated = toInputName(up);
              filesValue.push(annotated);
            }
            syncWidget();
            renderThumbs();
          } catch (err) {
            console.error(err);
            alert(err?.message ?? String(err));
          } finally {
            if (drop.firstChild) drop.firstChild.textContent = oldText || "Drop images here, or use the buttons below.";
          }
        }

        // Put DOM into the node
        node.addDOMWidget(inputName, "multi_image_upload", drop, {
          serialize: false,
          hideOnZoom: false,
        });

        node.size[0] = Math.max(node.size[0], minNodeWidth);
        node.size[1] = Math.max(node.size[1], minNodeHeight);

        // Initial render (in case workflow loads with existing value)
        try {
          const parsed = JSON.parse(w.value || "[]");
          if (Array.isArray(parsed)) filesValue = parsed;
        } catch {}
        renderThumbs();

        return { widget: w };
      },
    };
  },
});
