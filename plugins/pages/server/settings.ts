import type { BbPluginApi, PluginSettingDescriptors, PluginSettingsHandle } from "@get-bb/plugin-sdk";

/** Keep optional keys together before behavior controls in BB's native Configuration form. */
const PAGE_SETTINGS = {
    hereNowApiKey: { type: "string", label: "Here.now API key", description: "Creates and updates shared sites. Optional for local pages.", secret: true },
    mapboxToken: { type: "string", secret: true, label: "Mapbox token", description: "Adds map tiles. Without a token, maps use a blank grid." },
    defaultAccess: { type: "select", label: "Default access", description: "Access for new shares. Existing shares keep their access.", options: ["restricted", "password", "link"], experimental_optionLabels: { restricted: "Restricted", password: "Password", link: "Anyone with the link" }, default: "password" },
    defaultAllowedDomains: { type: "string", label: "Default allowed domains", description: "Comma-separated domains for new restricted shares, such as example.com.", default: "" },
    webLookups: { type: "boolean", label: "Web lookups", description: "Fetch map tiles, place names, photos, and linked images through the Pages server.", default: true },
    animations: { type: "boolean", label: "Animations", description: "Animate charts, scenes, maps, and apps. System reduced-motion preferences still apply.", default: true },
} satisfies PluginSettingDescriptors;

export type PageSettings = PluginSettingsHandle<typeof PAGE_SETTINGS>;

export function definePageSettings(bb: BbPluginApi): PageSettings {
  return bb.settings.define(PAGE_SETTINGS);
}
