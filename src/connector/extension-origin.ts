// Origin is a CORS boundary, not authentication: every call still needs a token/code.
export function isExtensionOrigin(origin:string) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin)||/^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin);
}
