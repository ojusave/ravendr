import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync(
  new URL("../static/images/og-image.svg", import.meta.url)
);
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: { loadSystemFonts: true },
})
  .render()
  .asPng();
writeFileSync(
  new URL("../static/images/og-image.png", import.meta.url),
  png
);
console.log(`og-image.png written (${png.length} bytes)`);
