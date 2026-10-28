import {readFileSync} from 'node:fs';
// Only an official release build (UBC_RELEASE=official) embeds the legacy hub
// origin from release/extension.json, to resume pre-0.4 connections. Dev and
// fork builds embed nothing. UBC_LEGACY_HUB_ORIGIN, when set, is used instead
// of the file (an explicit choice by whoever runs the build).
const official=process.env.UBC_RELEASE==='official';
const file=JSON.parse(readFileSync(new URL('../release/extension.json',import.meta.url),'utf8'));
export const legacyHubOrigin=process.env.UBC_LEGACY_HUB_ORIGIN||(official?file.legacyHubOrigin??'':'');
export const define={'globalThis.__UBC_LEGACY_HUB__':JSON.stringify(legacyHubOrigin)};
