import type { TocItem } from "../types";

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-");

export const extractToc = (markdown: string): TocItem[] => {
  const lines = markdown.split(/\r?\n/);
  const counter = new Map<string, number>();
  const items: TocItem[] = [];

  lines.forEach((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      return;
    }

    const text = match[2].trim();
    const base = slugify(text);
    const seen = counter.get(base) ?? 0;
    counter.set(base, seen + 1);

    items.push({
      level: match[1].length,
      text,
      slug: seen === 0 ? base : `${base}-${seen}`,
      index: items.length,
    });
  });

  return items;
};
