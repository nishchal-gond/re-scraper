// parser/shared-extractors.js

export function getNextData(source) {
  if (typeof source === "string") {
    const match = source.match(/<script\s+[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      return null;
    }
  } else if (source && typeof source.getElementById === "function") {
    const el = source.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }
  return null;
}

export function getJsonLdBlocks(source) {
  const blocks = [];
  if (typeof source === "string") {
    const regex = /<script\s+[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(source)) !== null) {
      try {
        blocks.push(JSON.parse(match[1]));
      } catch (e) {}
    }
  } else if (source && typeof source.querySelectorAll === "function") {
    const nodes = source.querySelectorAll('script[type="application/ld+json"]');
    nodes.forEach((n) => {
      try {
        blocks.push(JSON.parse(n.textContent));
      } catch (e) {}
    });
  }
  return blocks;
}

export function findJsonLdByType(source, typeName) {
  const blocks = getJsonLdBlocks(source);
  const flat = [];
  for (const b of blocks) {
    if (Array.isArray(b)) flat.push(...b);
    else if (b["@graph"]) flat.push(...b["@graph"]);
    else flat.push(b);
  }
  return flat.filter((b) => {
    const t = b["@type"];
    if (!t) return false;
    return Array.isArray(t) ? t.includes(typeName) : t === typeName;
  });
}
