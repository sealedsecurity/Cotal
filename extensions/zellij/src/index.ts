/** @cotal-ai/zellij — the zellij integration: a thin driver over the zellij CLI plus
 *  self-registering `zellij` Runtime and TerminalLayout providers. Importing the package
 *  registers both with the core Registry (like a connector), so the manager can spawn
 *  into zellij tabs and `cotal setup` can open/close them — neither depending on this
 *  package. The driver itself stays mesh-free; launch scripts import `./driver.js`
 *  directly to avoid the registration side effect. */
export * as zellij from "./driver.js";
// importing registers the zellij runtime + terminal-layout providers
export { ZellijRuntime, zellijRuntimeProvider, zellijTerminalProvider } from "./runtime.js";
