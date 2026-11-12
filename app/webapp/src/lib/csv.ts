export interface CsvTable {
  rows: string[][];
  truncated: boolean;
}

const MAX_ROWS = 5000;

export function parseDelimited(text: string, delimiter: "," | "\t"): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
      if (rows.length > MAX_ROWS) {
        truncated = true;
        break;
      }
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (!truncated && (field.length > 0 || row.length > 0)) pushRow();
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  for (const r of rows) while (r.length < cols) r.push("");
  return { rows, truncated };
}

export function delimiterFor(ext: string, text: string): "," | "\t" {
  if (ext === "tsv") return "\t";
  if (ext === "csv") return ",";
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
}
