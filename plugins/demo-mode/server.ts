import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    imageMask: {
      type: "select", label: "Image masking", default: "cover",
      options: ["cover", "pixelate"], experimental_optionLabels: { cover: "Solid cover", pixelate: "Pixelation" },
      description: "Choose how Demo Mode conceals images. Text uses solid word blocks.",
    },
    imagePixelSize: {
      type: "select", label: "Pixel size", default: "24",
      options: ["8", "12", "16", "24", "32", "48", "64"],
      experimental_optionLabels: Object.fromEntries([8, 12, 16, 24, 32, 48, 64].map(size => [String(size), `${size} px`])),
      description: "Screen pixels per block. Larger blocks hide more detail. Used when Image masking is Pixelation.",
    },
  });
}
