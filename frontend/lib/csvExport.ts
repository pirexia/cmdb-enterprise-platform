/**
 * Exports a dataset to a UTF-8 CSV file and triggers browser download.
 *
 * @param filename - Output filename (e.g. "inventario-cis.csv")
 * @param headers  - Column header labels
 * @param rows     - Data rows; each cell is coerced to string
 */
export function exportToCSV(
  filename: string,
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][]
): void {
  const escape = (value: string | number | boolean | null | undefined): string => {
    if (value == null) return "";
    const s = String(value);
    // RFC-4180: wrap in quotes if value contains commas, quotes or newlines
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ];

  // UTF-8 BOM ensures Excel opens with correct encoding
  const blob = new Blob(["\uFEFF" + lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
