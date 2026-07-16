// parser/registry.js
// Add a new site by importing its module and pushing it here.
// Nothing else in the codebase needs to change (see parser-interface.js).

import * as propertyfinder from "./propertyfinder.js";
// This build is intentionally scoped to Property Finder only.
export const PARSERS = [propertyfinder];

export function getParserForUrl(url) {
  return PARSERS.find((p) => p.matches(url)) || null;
}
