/**
 * zkteco-js (MIT) ships no type declarations. This is a minimal ambient shim
 * for the oracle tooling only — `any` is intentional; the whole point of this
 * tool is to observe wire bytes, not to typecheck against zkteco-js's API.
 */
declare module 'zkteco-js' {
  const ZKLib: any
  export default ZKLib
}
