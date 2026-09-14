export type JarMode = "empty" | "reuse" | "update";
export type ResetJar = "none" | "origin" | "all";

export const DEFAULT_JAR_MODE: JarMode = "empty";
export const DEFAULT_RESET_JAR: ResetJar = "none";

export function parseJarMode(raw: unknown): JarMode {
    if (raw === "reuse" || raw === "update" || raw === "empty") {
        return raw;
    }
    return DEFAULT_JAR_MODE;
}

export function parseResetJar(raw: unknown): ResetJar {
    if (raw === "origin" || raw === "all" || raw === "none") {
        return raw;
    }
    return DEFAULT_RESET_JAR;
}

/** scheme + host + port. Throws if `url` is not a valid absolute URL. */
export function parseJobOrigin(url: string): string {
    return new URL(url).origin;
}
