// The drill itself is plain .mjs and cannot import TypeScript; the pinning
// spec is TypeScript and must see a declared contract here rather than
// needing `allowJs` (which would silently typecheck any .js import repo-wide).

export function consumerPackageJson(): string
export function consumerSource(): string
export function consumerTsconfig(repoRoot: string): string
