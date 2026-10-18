import { File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, type LucideIcon } from "lucide-react";

/*
 * One file-type icon for every file list (question evidence rows, the
 * workspace file tree): chosen by the file name's extension.
 */

const FILE_ICONS: [RegExp, LucideIcon][] = [
  [/\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/iu, FileImage],
  [/\.(zip|tar|gz|tgz|7z|rar)$/iu, FileArchive],
  [/\.(csv|tsv|xlsx?|ods)$/iu, FileSpreadsheet],
  [/\.(c|h|cpp|hpp|cc|py|m|js|ts|tsx|json|ya?ml|vhdl?|sv|v|xml|html?)$/iu, FileCode],
  [/\.(md|txt|pdf|docx?|rtf|odt)$/iu, FileText],
];

/** The icon for a file name (or path); `fallback` when its type is not one of the known kinds. */
export function fileTypeIcon(name: string, fallback: LucideIcon = File): LucideIcon {
  const base = name.split("/").at(-1) ?? name;
  return FILE_ICONS.find(([pattern]) => pattern.test(base))?.[1] ?? fallback;
}
